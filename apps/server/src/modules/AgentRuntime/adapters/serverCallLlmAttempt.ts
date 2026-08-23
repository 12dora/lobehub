import type {
  AgentEvent,
  AgentState,
  CallLLMPayload,
  InstructionExecutor,
} from '@lobechat/agent-runtime';
import type { ChatStreamPayload, ModelRuntime } from '@lobechat/model-runtime';
import { consumeStreamUntilDone } from '@lobechat/model-runtime';
import { isRecord } from '@lobechat/utils/object';

import type { RuntimeExecutorContext } from '../context';
import { log } from '../executorHelpers';
import { createServerCallLlmCallbacks } from './serverCallLlmCallbacks';
import { assertNonEmptyCompletion, salvageAnswerFromThinking } from './serverCallLlmCompletion';
import type { GeneratedFileUploader } from './serverCallLlmGeneratedFile';
import { publishCallLlmOutput } from './serverCallLlmOutput';
import { buildCallLlmResult, persistSuccessfulCallLlmMessage } from './serverCallLlmPersistence';
import type { ServerCallLlmStreamSink } from './serverCallLlmStreamSink';
import type { ServerCallLlmTooling } from './serverCallLlmTooling';
import type { ServerCallLlmAttemptState } from './serverCallLlmTypes';

export interface RunServerCallLlmAttemptInput {
  assistantMessageId: string;
  attempt: number;
  attemptState: ServerCallLlmAttemptState;
  chatPayload: ChatStreamPayload;
  ctx: RuntimeExecutorContext;
  events: AgentEvent[];
  firstChunk: { at?: number };
  generatedFiles: GeneratedFileUploader;
  llmPayload: CallLLMPayload;
  llmStartTime: number;
  maxAttempts: number;
  model: string;
  modelRuntime: ModelRuntime;
  operationLogId: string;
  provider: string;
  shouldReplayAssistantReasoning: boolean;
  stagePrefix: string;
  state: AgentState;
  stepLabel?: string;
  streamSink: ServerCallLlmStreamSink;
  tooling: ServerCallLlmTooling;
}

export const createServerCallLlmAttemptState = (): ServerCallLlmAttemptState => ({
  answerSalvagedFromReasoning: false,
  grounding: null,
  imageList: [],
  toolCalls: [],
  toolsCalling: [],
});

const throwCapturedStreamError = (streamError: unknown): never => {
  const message = isRecord(streamError) ? streamError.message : undefined;
  const streamExecutionError = new Error(
    typeof message === 'string'
      ? `LLM stream error: ${message}`
      : `LLM stream error: ${JSON.stringify(streamError)}`,
  );
  if (isRecord(streamError)) {
    const { message: _message, ...restStreamError } = streamError;
    Object.assign(streamExecutionError, restStreamError);
  }
  throw streamExecutionError;
};

const callModelRuntime = async (input: RunServerCallLlmAttemptInput) => {
  const {
    assistantMessageId,
    attempt,
    attemptState,
    chatPayload,
    ctx,
    firstChunk,
    generatedFiles,
    llmStartTime,
    maxAttempts,
    model,
    modelRuntime,
    operationLogId,
    stagePrefix,
    streamSink,
    tooling,
  } = input;
  log(
    `${stagePrefix} calling model-runtime chat (attempt %d/%d, model: %s, messages: %d, tools: %d)`,
    attempt,
    maxAttempts,
    model,
    chatPayload.messages.length,
    chatPayload.tools?.length ?? 0,
  );
  const response = await modelRuntime.chat(chatPayload, {
    callback: createServerCallLlmCallbacks({
      attemptState,
      ctx,
      firstChunk,
      generatedFiles,
      llmStartTime,
      operationLogId,
      streamSink,
      tooling,
    }),
    metadata: {
      assistantMessageId,
      operationId: ctx.operationId,
      topicId: input.state.metadata?.topicId,
      trigger: input.state.metadata?.trigger,
    },
    user: ctx.userId,
  });
  await consumeStreamUntilDone(response);
  if (attemptState.streamError) throwCapturedStreamError(attemptState.streamError);
};

const settleAttemptOutput = async (
  streamSink: ServerCallLlmStreamSink,
  generatedFiles: GeneratedFileUploader,
) => {
  // Reasoning first so leftover thinking cannot land after the answer.
  await streamSink.flushEndOfStream();
  streamSink.endReasoningPhase();
  streamSink.clearBuffers();
  await streamSink.waitForImageUploads();
  await generatedFiles.waitForUploads();
};

export const runServerCallLlmAttempt = async (
  input: RunServerCallLlmAttemptInput,
): ReturnType<InstructionExecutor> => {
  await callModelRuntime(input);
  await settleAttemptOutput(input.streamSink, input.generatedFiles);
  await assertNonEmptyCompletion(input);
  salvageAnswerFromThinking(input);
  const visibleOutputEndPublishedStepIndex = await publishCallLlmOutput(input);
  log('[%s:%d] call_llm completed', input.ctx.operationId, input.ctx.stepIndex);
  const finalReasoning = await persistSuccessfulCallLlmMessage(input);
  return buildCallLlmResult({
    ...input,
    finalReasoning,
    operationId: input.ctx.operationId,
    visibleOutputEndPublishedStepIndex,
  });
};
