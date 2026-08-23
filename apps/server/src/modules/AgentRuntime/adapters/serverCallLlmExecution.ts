import {
  type AgentEvent,
  getLLMRetryDelayMs,
  resolveLLMRetryBudget,
  shouldRetryLLM,
} from '@lobechat/agent-runtime';
import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  trace as otelTrace,
} from '@lobechat/observability-otel/api';
import {
  buildChatRequestAttributes,
  buildChatResponseAttributes,
  chatSpanName,
  tracer as agentRuntimeTracer,
} from '@lobechat/observability-otel/modules/agent-runtime';

import { isOperationInterrupted, log, sleep } from '../executorHelpers';
import { classifyLLMError } from '../llmErrorClassification';
import {
  createServerCallLlmAttemptState,
  runServerCallLlmAttempt,
  type RunServerCallLlmAttemptInput,
} from './serverCallLlmAttempt';
import {
  createGeneratedFileDedupeStore,
  createGeneratedFileUploader,
} from './serverCallLlmGeneratedFile';
import { persistInterruptedCallLlmMessage } from './serverCallLlmPersistence';
import { createServerCallLlmStreamSink } from './serverCallLlmStreamSink';
import type { ServerCallLlmExecutionInput } from './serverCallLlmTypes';

interface RetryPolicy {
  noRetryProviders: string[];
}

const publishRetry = async (
  input: ServerCallLlmExecutionInput,
  events: AgentEvent[],
  attempt: number,
  maxAttempts: number,
  kind: string,
  code: string | undefined,
  delayMs: number,
) => {
  log(
    '[%s] LLM call failed with kind=%s (attempt %d/%d), retrying in %dms ...',
    input.operationLogId,
    kind,
    attempt,
    maxAttempts,
    delayMs,
  );
  const retryEvent: AgentEvent = {
    data: { attempt: attempt + 1, delayMs, errorType: code, kind, maxAttempts },
    type: 'stream_retry',
  };
  events.push(retryEvent);
  await input.ctx.streamManager.publishStreamEvent(input.ctx.operationId, {
    data: retryEvent.data,
    stepIndex: input.ctx.stepIndex,
    type: 'stream_retry',
  });
  await sleep(delayMs);
};

const handleAttemptError = async ({
  attempt,
  error,
  input,
  policy,
  runInput,
}: {
  attempt: number;
  error: unknown;
  input: ServerCallLlmExecutionInput;
  policy: RetryPolicy;
  runInput: RunServerCallLlmAttemptInput;
}): Promise<'retry'> => {
  await runInput.streamSink.cancelAndDrain();
  const classified = classifyLLMError(error);
  const interrupted = await isOperationInterrupted(input.ctx);
  const retryBudget = resolveLLMRetryBudget(input.provider, policy);

  if (!interrupted && shouldRetryLLM(classified.kind, attempt, retryBudget)) {
    const delayMs = getLLMRetryDelayMs(attempt);
    await publishRetry(
      input,
      input.events,
      attempt,
      input.maxAttempts,
      classified.kind,
      classified.code,
      delayMs,
    );
    if (await isOperationInterrupted(input.ctx)) throw error;
    return 'retry';
  }

  if (interrupted) {
    await persistInterruptedCallLlmMessage({
      ...runInput,
      assistantMessageId: input.assistantMessageId,
      operationLogId: input.operationLogId,
    });
  }
  throw error;
};

const executeAttempts = async (
  input: ServerCallLlmExecutionInput,
  policy: RetryPolicy,
  llmStartTime: number,
  firstChunk: { at?: number },
  chatSpan: ReturnType<typeof agentRuntimeTracer.startSpan>,
) => {
  // Attempts share one assistant message, so identical regenerated exports
  // must dedupe across the whole operation rather than within one attempt.
  const generatedFileDedupe = createGeneratedFileDedupeStore();
  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    const streamSink = createServerCallLlmStreamSink({
      ctx: input.ctx,
      events: input.events,
      operationLogId: input.operationLogId,
    });
    const generatedFiles = createGeneratedFileUploader({
      assistantMessageId: input.assistantMessageId,
      ctx: input.ctx,
      dedupe: generatedFileDedupe,
      operationLogId: input.operationLogId,
    });
    const attemptState = createServerCallLlmAttemptState();
    const runInput = {
      ...input,
      attempt,
      attemptState,
      firstChunk,
      generatedFiles,
      llmStartTime,
      streamSink,
    };
    try {
      const result = await runServerCallLlmAttempt(runInput);
      chatSpan.setAttributes(
        buildChatResponseAttributes({
          cacheReadInputTokens: attemptState.usage?.inputCachedTokens,
          finishReasons: attemptState.finishReason ? [attemptState.finishReason] : undefined,
          inputTokens: attemptState.usage?.totalInputTokens,
          outputTokens: attemptState.usage?.totalOutputTokens,
          reasoningOutputTokens: attemptState.usage?.outputReasoningTokens,
          timeToFirstChunkMs: firstChunk.at,
        }),
      );
      return result;
    } catch (error) {
      await handleAttemptError({ attempt, error, input, policy, runInput });
    } finally {
      // Stop an in-flight upload from attaching or publishing after this
      // attempt has already retried, failed, or been interrupted.
      await generatedFiles.cancel();
    }
  }
  throw new Error('LLM execution retry loop exited unexpectedly');
};

export const executeServerCallLlm = async (
  input: ServerCallLlmExecutionInput,
  policy: RetryPolicy,
) => {
  const llmStartTime = Date.now();
  const firstChunk: { at?: number } = {};
  const stream = input.chatPayload.stream ?? true;
  // One semantic chat span covers every retry; TTFT belongs to the first chunk
  // produced by any attempt.
  const chatSpan = agentRuntimeTracer.startSpan(chatSpanName(input.model), {
    attributes: buildChatRequestAttributes({
      conversationId: input.state.metadata?.topicId,
      operationId: input.ctx.operationId,
      provider: input.provider,
      requestModel: input.model,
      stepIndex: input.ctx.stepIndex,
      stream,
    }),
    kind: SpanKind.CLIENT,
  });
  const chatCtx = otelTrace.setSpan(otelContext.active(), chatSpan);

  try {
    return await otelContext.with(chatCtx, () =>
      executeAttempts(input, policy, llmStartTime, firstChunk, chatSpan),
    );
  } catch (error) {
    chatSpan.recordException(error as Error);
    chatSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    chatSpan.end();
  }
};
