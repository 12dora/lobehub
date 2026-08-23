import type { AgentEvent } from '@lobechat/agent-runtime';

import type { RuntimeExecutorContext } from '../context';
import { log } from '../executorHelpers';
import type { ServerCallLlmStreamSink } from './serverCallLlmStreamSink';
import type { ServerCallLlmAttemptState } from './serverCallLlmTypes';

export const publishCallLlmOutput = async ({
  attemptState,
  ctx,
  events,
  operationLogId,
  stepLabel,
  streamSink,
}: {
  attemptState: ServerCallLlmAttemptState;
  ctx: RuntimeExecutorContext;
  events: AgentEvent[];
  operationLogId: string;
  stepLabel?: string;
  streamSink: ServerCallLlmStreamSink;
}): Promise<number | undefined> => {
  log(
    `[${operationLogId}] finish model-runtime calling | content: %d chars | reasoning: %d chars | tools: %d | usage: %s`,
    streamSink.content.length,
    streamSink.thinkingContent.length,
    attemptState.toolsCalling.length,
    attemptState.usage ? 'yes' : 'none',
  );
  if (streamSink.thinkingContent) log(`[${operationLogId}][reasoning]`, streamSink.thinkingContent);
  if (streamSink.content) log(`[${operationLogId}][content]`, streamSink.content);
  if (attemptState.toolsCalling.length > 0)
    log(`[${operationLogId}][toolsCalling] `, attemptState.toolsCalling);
  if (attemptState.usage) log(`[${operationLogId}][usage] %O`, attemptState.usage);

  events.push({
    result: {
      content: streamSink.content,
      finishReason: attemptState.finishReason,
      reasoning: streamSink.thinkingContent,
      tool_calls: attemptState.toolCalls,
      usage: attemptState.usage,
    },
    type: 'llm_result',
  });
  await ctx.streamManager.publishStreamEvent(ctx.operationId, {
    data: {
      finalContent: streamSink.content,
      ...(attemptState.finishReason ? { finishReason: attemptState.finishReason } : {}),
      grounding: attemptState.grounding,
      ...(stepLabel ? { stepLabel } : {}),
      imageList: attemptState.imageList.length > 0 ? attemptState.imageList : undefined,
      reasoning: streamSink.thinkingContent || undefined,
      toolsCalling: attemptState.toolsCalling,
      usage: attemptState.usage,
    },
    stepIndex: ctx.stepIndex,
    type: 'stream_end',
  });

  const canPublish = ctx.allowEarlyFinalAnswerVisibleOutputEnd ?? true;
  if (!canPublish || attemptState.toolsCalling.length > 0 || attemptState.toolCalls.length > 0)
    return undefined;

  try {
    await ctx.streamManager.publishStreamEvent(ctx.operationId, {
      data: { reason: 'final_answer' },
      stepIndex: ctx.stepIndex,
      type: 'visible_output_end',
    });
    return ctx.stepIndex;
  } catch (error) {
    console.error('Failed to publish visible_output_end:', error);
    return undefined;
  }
};
