import {
  type AgentEvent,
  type AgentState,
  type CallLLMPayload,
  type GeneralAgentCallLLMResultPayload,
  UsageCounter,
} from '@lobechat/agent-runtime';
import type { GroundingSearch, ModelReasoning } from '@lobechat/types';
import { sanitizeToolCallArguments, serializePartsForStorage } from '@lobechat/utils';
import { isObjectLike } from '@lobechat/utils/object';

import type { RuntimeExecutorContext } from '../context';
import { log } from '../executorHelpers';
import { VISIBLE_OUTPUT_END_PUBLISHED_STEP_INDEX_METADATA_KEY } from '../visibleOutputEnd';
import type { ServerCallLlmStreamSink } from './serverCallLlmStreamSink';
import type { ServerCallLlmAttemptState } from './serverCallLlmTypes';

const buildFinalReasoning = (
  attemptState: ServerCallLlmAttemptState,
  streamSink: ServerCallLlmStreamSink,
): ModelReasoning | undefined => {
  if (streamSink.hasReasoningImages) {
    return { content: serializePartsForStorage(streamSink.reasoningParts), isMultimodal: true };
  }
  if (attemptState.capturedReasoning) {
    return {
      ...attemptState.capturedReasoning,
      content: streamSink.thinkingContent || attemptState.capturedReasoning.content,
    };
  }
  if (streamSink.thinkingContent) return { content: streamSink.thinkingContent };
};

const buildMessageMetadata = (
  attemptState: ServerCallLlmAttemptState,
  streamSink: ServerCallLlmStreamSink,
) => {
  const metadata: Record<string, unknown> = {};
  if (attemptState.usage && isObjectLike(attemptState.usage)) {
    Object.assign(metadata, attemptState.usage);
    metadata.usage = attemptState.usage;
  }
  if (attemptState.speed && isObjectLike(attemptState.speed)) {
    Object.assign(metadata, attemptState.speed);
    metadata.performance = attemptState.speed;
  }
  if (streamSink.hasContentImages) metadata.isMultimodal = true;
  if (attemptState.answerSalvagedFromReasoning) metadata.answerSalvagedFromReasoning = true;
  if (attemptState.finishReason) metadata.finishReason = attemptState.finishReason;
  return metadata;
};

export const persistSuccessfulCallLlmMessage = async ({
  assistantMessageId,
  attemptState,
  ctx,
  streamSink,
}: {
  assistantMessageId: string;
  attemptState: ServerCallLlmAttemptState;
  ctx: RuntimeExecutorContext;
  streamSink: ServerCallLlmStreamSink;
}): Promise<ModelReasoning | undefined> => {
  const finalContent = streamSink.hasContentImages
    ? serializePartsForStorage(streamSink.contentParts)
    : streamSink.content;
  const finalReasoning = buildFinalReasoning(attemptState, streamSink);
  const metadata = buildMessageMetadata(attemptState, streamSink);
  // Raw malformed arguments remain available to tool execution, but DB/state
  // history must be safe to replay into strict providers.
  const persistedTools =
    attemptState.toolsCalling.length > 0
      ? attemptState.toolsCalling.map((tool) => ({
          ...tool,
          arguments: sanitizeToolCallArguments(tool.arguments),
        }))
      : undefined;

  try {
    await ctx.messageModel.update(assistantMessageId, {
      content: finalContent,
      imageList: attemptState.imageList.length > 0 ? attemptState.imageList : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      reasoning: finalReasoning,
      search: attemptState.grounding as GroundingSearch,
      tools: persistedTools,
    });
  } catch (error) {
    console.error('[call_llm] Failed to update message:', error);
  }
  return finalReasoning;
};

const updateStateMetadata = (
  newState: AgentState,
  stepLabel: string | undefined,
  visibleOutputEndPublishedStepIndex: number | undefined,
) => {
  if (!stepLabel && visibleOutputEndPublishedStepIndex === undefined) return;
  const stateMetadata = { ...newState.metadata };
  if (stepLabel) stateMetadata._stepLabel = stepLabel;
  if (visibleOutputEndPublishedStepIndex !== undefined) {
    stateMetadata[VISIBLE_OUTPUT_END_PUBLISHED_STEP_INDEX_METADATA_KEY] =
      visibleOutputEndPublishedStepIndex;
  }
  newState.metadata = stateMetadata;
};

export const buildCallLlmResult = ({
  assistantMessageId,
  attemptState,
  events,
  finalReasoning,
  llmPayload,
  operationId,
  shouldReplayAssistantReasoning,
  state,
  stepLabel,
  streamSink,
  visibleOutputEndPublishedStepIndex,
}: {
  assistantMessageId: string;
  attemptState: ServerCallLlmAttemptState;
  events: AgentEvent[];
  finalReasoning?: ModelReasoning;
  llmPayload: CallLLMPayload;
  operationId: string;
  shouldReplayAssistantReasoning: boolean;
  state: AgentState;
  stepLabel?: string;
  streamSink: ServerCallLlmStreamSink;
  visibleOutputEndPublishedStepIndex?: number;
}) => {
  const newState = structuredClone(state);
  const sanitizedToolCalls = attemptState.toolCalls
    .filter((toolCall) => !!toolCall.function.name)
    .map((toolCall) => ({
      ...toolCall,
      function: {
        ...toolCall.function,
        arguments: sanitizeToolCallArguments(toolCall.function.arguments),
      },
    }));
  newState.messages.push({
    content: streamSink.content,
    id: assistantMessageId,
    // The DB always retains reasoning for refreshed UI; this flag only gates
    // replay into the next model payload.
    reasoning: shouldReplayAssistantReasoning ? finalReasoning : undefined,
    role: 'assistant',
    tool_calls: sanitizedToolCalls.length > 0 ? sanitizedToolCalls : undefined,
  });

  if (attemptState.usage) {
    const { usage, cost } = UsageCounter.accumulateLLM({
      cost: newState.cost,
      model: llmPayload.model,
      modelUsage: attemptState.usage,
      provider: llmPayload.provider,
      usage: newState.usage,
    });
    newState.usage = usage;
    if (cost) newState.cost = cost;
  }
  updateStateMetadata(newState, stepLabel, visibleOutputEndPublishedStepIndex);

  return {
    events,
    newState,
    nextContext: {
      payload: {
        hasToolsCalling: attemptState.toolsCalling.length > 0,
        parentMessageId: assistantMessageId,
        result: { content: streamSink.content, tool_calls: attemptState.toolCalls },
        toolsCalling: attemptState.toolsCalling,
      } as GeneralAgentCallLLMResultPayload,
      phase: 'llm_result' as const,
      session: {
        eventCount: events.length,
        messageCount: newState.messages.length,
        sessionId: operationId,
        status: 'running' as const,
        stepCount: state.stepCount + 1,
      },
      stepUsage: attemptState.usage,
    },
  };
};

export const persistInterruptedCallLlmMessage = async ({
  assistantMessageId,
  attemptState,
  ctx,
  operationLogId,
  streamSink,
}: {
  assistantMessageId: string;
  attemptState: ServerCallLlmAttemptState;
  ctx: RuntimeExecutorContext;
  operationLogId: string;
  streamSink: ServerCallLlmStreamSink;
}) => {
  const hasPartialOutput =
    streamSink.content ||
    streamSink.thinkingContent ||
    attemptState.toolsCalling.length > 0 ||
    attemptState.capturedReasoning;
  if (!hasPartialOutput) return;

  try {
    const tools = attemptState.toolsCalling.map((tool) => ({
      ...tool,
      arguments: sanitizeToolCallArguments(tool.arguments),
    }));
    const reasoning = attemptState.capturedReasoning
      ? {
          ...attemptState.capturedReasoning,
          content: streamSink.thinkingContent || attemptState.capturedReasoning.content,
        }
      : streamSink.thinkingContent
        ? { content: streamSink.thinkingContent }
        : undefined;
    const metadata: Record<string, unknown> = { interruptedMidStream: true };
    if (attemptState.usage && isObjectLike(attemptState.usage)) {
      Object.assign(metadata, attemptState.usage);
      metadata.usage = attemptState.usage;
    }
    if (attemptState.speed && isObjectLike(attemptState.speed)) {
      Object.assign(metadata, attemptState.speed);
      metadata.performance = attemptState.speed;
    }
    await ctx.messageModel.update(assistantMessageId, {
      content: streamSink.content,
      metadata,
      reasoning,
      tools: tools.length > 0 ? tools : undefined,
    });
    log(
      '[%s] Interrupted finalize: persisted partial content (c=%d r=%d tools=%d)',
      operationLogId,
      streamSink.content.length,
      streamSink.thinkingContent.length,
      attemptState.toolsCalling.length,
    );
  } catch (persistErr) {
    log('[%s] Interrupted finalize update failed: %O', operationLogId, persistErr);
  }
};
