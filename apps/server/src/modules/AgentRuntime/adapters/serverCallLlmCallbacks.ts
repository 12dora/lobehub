import { ToolNameResolver } from '@lobechat/context-engine';
import type { ChatStreamCallbacks } from '@lobechat/model-runtime';

import type { RuntimeExecutorContext } from '../context';
import { log, timing } from '../executorHelpers';
import type { GeneratedFileUploader } from './serverCallLlmGeneratedFile';
import type { ServerCallLlmStreamSink } from './serverCallLlmStreamSink';
import type { ServerCallLlmTooling } from './serverCallLlmTooling';
import type { ServerCallLlmAttemptState } from './serverCallLlmTypes';

interface CallbackInput {
  attemptState: ServerCallLlmAttemptState;
  ctx: RuntimeExecutorContext;
  firstChunk: { at?: number };
  generatedFiles: GeneratedFileUploader;
  llmStartTime: number;
  operationLogId: string;
  streamSink: ServerCallLlmStreamSink;
  tooling: ServerCallLlmTooling;
}

const markFirstChunk = (firstChunk: { at?: number }, llmStartTime: number) => {
  if (firstChunk.at === undefined) firstChunk.at = Date.now() - llmStartTime;
};

const createTextCallbacks = ({
  firstChunk,
  llmStartTime,
  operationLogId,
  streamSink,
}: Pick<CallbackInput, 'firstChunk' | 'llmStartTime' | 'operationLogId' | 'streamSink'>) =>
  ({
    // Gemini can deliver text/reasoning and images only as part events. Images
    // must be uploaded before persistence so raw base64 never enters history.
    onBase64Image: async ({ image }) => {
      markFirstChunk(firstChunk, llmStartTime);
      await streamSink.appendBase64Image(image);
    },
    onContentPart: async (part) => {
      markFirstChunk(firstChunk, llmStartTime);
      await streamSink.appendContentPart(part);
    },
    onReasoningPart: async (part) => {
      markFirstChunk(firstChunk, llmStartTime);
      await streamSink.appendReasoningPart(part);
    },
    onText: async (text) => {
      markFirstChunk(firstChunk, llmStartTime);
      timing(
        '[%s] onText received chunk at %d, length: %d',
        operationLogId,
        Date.now(),
        text.length,
      );
      await streamSink.appendText(text);
    },
    onThinking: async (reasoning) => {
      markFirstChunk(firstChunk, llmStartTime);
      timing(
        '[%s] onThinking received chunk at %d, length: %d',
        operationLogId,
        Date.now(),
        reasoning.length,
      );
      await streamSink.appendThinking(reasoning);
    },
  }) satisfies ChatStreamCallbacks;

const createResultCallbacks = ({
  attemptState,
  ctx,
  operationLogId,
}: Pick<CallbackInput, 'attemptState' | 'ctx' | 'operationLogId'>) =>
  ({
    onCompletion: async (data) => {
      attemptState.capturedReasoning = data.reasoning;
      if (data.usage) attemptState.usage = data.usage;
      if (data.speed) attemptState.speed = data.speed;
      if (data.finishReason) attemptState.finishReason = data.finishReason;
    },
    onError: async (errorData) => {
      attemptState.streamError = errorData;
      console.error(`[${operationLogId}][stream_error]`, errorData);
    },
    onGrounding: async (groundingData) => {
      log(`[${operationLogId}][grounding] %O`, groundingData);
      attemptState.grounding = groundingData;
      await ctx.streamManager.publishStreamChunk(ctx.operationId, ctx.stepIndex, {
        chunkType: 'grounding',
        grounding: groundingData,
      });
    },
  }) satisfies ChatStreamCallbacks;

const createToolCallbacks = ({
  attemptState,
  ctx,
  streamSink,
  tooling,
}: Pick<CallbackInput, 'attemptState' | 'ctx' | 'streamSink' | 'tooling'>) =>
  ({
    onToolsCalling: async ({ toolsCalling: raw }) => {
      const { resolved } = tooling;
      const resolvedCalls = new ToolNameResolver().resolve(
        raw,
        resolved.promptManifestMap,
        resolved.tools.map((tool) => tool.function.name),
      );
      // Keep raw arguments so the executor can surface malformed JSON to the
      // model; sanitization belongs only at persistence boundaries.
      const payload = resolvedCalls.map((call) => ({
        ...call,
        executor: resolved.executorMap?.[call.identifier],
        source: resolved.sourceMap[call.identifier],
      }));
      attemptState.toolsCalling = payload;
      attemptState.toolCalls = raw;

      await streamSink.flushEndOfStream();
      streamSink.endReasoningPhase();
      await ctx.streamManager.publishStreamChunk(ctx.operationId, ctx.stepIndex, {
        chunkType: 'tools_calling',
        toolsCalling: payload,
      });
    },
  }) satisfies ChatStreamCallbacks;

export const createServerCallLlmCallbacks = (input: CallbackInput): ChatStreamCallbacks => ({
  ...createResultCallbacks(input),
  ...createTextCallbacks(input),
  ...createToolCallbacks(input),
  // Generated files are fire-and-forget here, then settled before the terminal
  // message snapshot so export failures never fail an otherwise valid answer.
  onFile: async ({ file }) => {
    input.generatedFiles.handleFile(file);
  },
});
