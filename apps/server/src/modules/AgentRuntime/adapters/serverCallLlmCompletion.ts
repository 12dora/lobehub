import type { AgentState } from '@lobechat/agent-runtime';
import type { ChatStreamPayload } from '@lobechat/model-runtime';
import {
  isEmptyModelCompletion,
  ModelEmptyError,
  ModelRefusalError,
} from '@lobechat/model-runtime';

import { recordModelCompletionFailure } from '@/business/server/recordModelCompletionFailure';

import type { RuntimeExecutorContext } from '../context';
import { isOperationInterrupted, log } from '../executorHelpers';
import type { GeneratedFileUploader } from './serverCallLlmGeneratedFile';
import type { ServerCallLlmStreamSink } from './serverCallLlmStreamSink';
import type { ServerCallLlmAttemptState } from './serverCallLlmTypes';

interface CompletionInput {
  attempt: number;
  attemptState: ServerCallLlmAttemptState;
  chatPayload: ChatStreamPayload;
  ctx: RuntimeExecutorContext;
  generatedFiles: GeneratedFileUploader;
  maxAttempts: number;
  model: string;
  operationLogId: string;
  provider: string;
  state: AgentState;
  streamSink: ServerCallLlmStreamSink;
}

/** Answer-in-thinking salvage only applies to a natural, non-tool completion. */
export const isAnswerInThinkingSalvageFinishReason = (finishReason?: string) =>
  finishReason === 'end_turn' || finishReason === 'stop';

const completionCounts = ({ attemptState, generatedFiles, streamSink }: CompletionInput) => {
  const reportedOutputTokens = attemptState.usage?.totalOutputTokens;
  const contentPartImageCount = streamSink.contentParts.filter(
    (part) => part.type === 'image',
  ).length;
  return {
    fileCount: generatedFiles.attachedFileCount(),
    imageCount: attemptState.imageList.length + contentPartImageCount,
    outputTokens: typeof reportedOutputTokens === 'number' ? reportedOutputTokens : undefined,
    toolCallCount: attemptState.toolsCalling.length + attemptState.toolCalls.length,
  };
};

const recordCompletionFailure = async (
  input: CompletionInput,
  reason: 'empty_completion' | 'refusal',
) => {
  const { attempt, attemptState, chatPayload, ctx, maxAttempts, model, operationLogId, provider } =
    input;
  const { streamSink } = input;
  try {
    await recordModelCompletionFailure({
      attempt,
      maxAttempts,
      model,
      operationId: ctx.operationId,
      operationLogId,
      provider,
      reason,
      request: chatPayload,
      response: {
        content: streamSink.content,
        contentParts: [...streamSink.contentParts],
        finishReason: attemptState.finishReason,
        grounding: attemptState.grounding,
        imageList: [...attemptState.imageList],
        reasoning: streamSink.thinkingContent,
        reasoningParts: [...streamSink.reasoningParts],
        toolCalls: [...attemptState.toolCalls],
        toolsCalling: [...attemptState.toolsCalling],
        usage: attemptState.usage,
      },
      stepIndex: ctx.stepIndex,
      topicId: input.state.metadata?.topicId,
      trigger: input.state.metadata?.trigger,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
  } catch (error) {
    console.error('[ModelCompletionFailure] Failed to record completion evidence.', {
      error: error instanceof Error ? error.message : String(error),
      operationId: ctx.operationId,
      stepIndex: ctx.stepIndex,
    });
  }
};

export const assertNonEmptyCompletion = async (input: CompletionInput) => {
  const { attempt, attemptState, ctx, maxAttempts, model, operationLogId, provider, streamSink } =
    input;
  const counts = completionCounts(input);
  const isRefusal = String(attemptState.finishReason).toLowerCase() === 'refusal';
  const visibleReasoning = isRefusal ? '' : streamSink.thinkingContent;
  const empty = isEmptyModelCompletion({
    content: streamSink.content,
    ...counts,
    hasGrounding: !!attemptState.grounding,
    reasoning: visibleReasoning,
  });
  if (!empty || (await isOperationInterrupted(ctx))) return;

  const diagnostics = {
    attempt,
    contentLength: streamSink.content.length,
    cost: attemptState.usage?.cost,
    finishReason: attemptState.finishReason,
    maxAttempts,
    model,
    provider,
    reasoningLength: streamSink.thinkingContent.length,
    ...counts,
  };
  await recordCompletionFailure(input, isRefusal ? 'refusal' : 'empty_completion');

  if (isRefusal) {
    log(
      '[%s] Model explicitly refused an empty completion (attempt %d/%d) — throwing terminal ModelRefusalError',
      operationLogId,
      attempt,
      maxAttempts,
    );
    throw new ModelRefusalError(undefined, diagnostics);
  }
  log(
    '[%s] Model returned an empty completion (attempt %d/%d) — throwing terminal ModelEmptyError',
    operationLogId,
    attempt,
    maxAttempts,
  );
  throw new ModelEmptyError(undefined, diagnostics);
};

export const salvageAnswerFromThinking = ({
  attemptState,
  operationLogId,
  streamSink,
}: Pick<CompletionInput, 'attemptState' | 'operationLogId' | 'streamSink'>) => {
  // Some thinking models occasionally place the final answer in reasoning.
  // Only natural plain completions may promote it; tool, truncated, filtered,
  // or multimodal reasoning must retain its original channel semantics.
  if (
    !isAnswerInThinkingSalvageFinishReason(attemptState.finishReason) ||
    attemptState.toolsCalling.length > 0 ||
    attemptState.toolCalls.length > 0 ||
    streamSink.content.trim().length > 0 ||
    streamSink.thinkingContent.trim().length === 0 ||
    streamSink.hasReasoningImages
  )
    return;

  log(
    '[%s] answer-in-thinking salvage: promoting %d chars of reasoning to content',
    operationLogId,
    streamSink.thinkingContent.length,
  );
  streamSink.content = streamSink.thinkingContent;
  streamSink.thinkingContent = '';
  attemptState.answerSalvagedFromReasoning = true;
};
