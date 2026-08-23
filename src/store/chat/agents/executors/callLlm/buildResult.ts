import type {
  AgentRuntimeContext,
  AgentState,
  GeneralAgentCallLLMInstructionPayload,
  GeneralAgentCallLLMResultPayload,
  InstructionExecutor,
} from '@lobechat/agent-runtime';
import { UsageCounter } from '@lobechat/agent-runtime';

import type { StreamingHandler } from '../../StreamingHandler';
import type { AgentExecutorContext } from '../shared';
import { log } from '../shared';
import type { CallLlmStreamOutcome } from './types';

interface BuildCallLlmResultParams {
  assistantMessageId: string;
  context: AgentExecutorContext;
  handler: StreamingHandler;
  llmPayload: GeneralAgentCallLLMInstructionPayload;
  outcome: CallLlmStreamOutcome;
  sessionLogId: string;
  stagePrefix: string;
  state: AgentState;
}

/** Reads the settled stream out of the handler and turns it into the next runtime context. */
export const buildCallLlmResult = ({
  assistantMessageId,
  context,
  handler,
  llmPayload,
  outcome,
  sessionLogId,
  stagePrefix,
  state,
}: BuildCallLlmResultParams): Awaited<ReturnType<InstructionExecutor>> => {
  const isFunctionCall = handler.getIsFunctionCall();
  const content = handler.getOutput();
  const tools = handler.getTools();
  const currentStepUsage = outcome.usage;
  const tool_calls = outcome.toolCalls;
  const finishType = handler.getFinishType();

  log(`[${sessionLogId}] finish model-runtime calling`);

  // Get latest messages from store (already updated by internal_fetchAIChatMessage)
  const latestMessages = context.get().dbMessagesMap[context.messageKey] || [];

  log(
    `${stagePrefix} After fetch: dbMessagesMap[${context.messageKey}]=%d messages, available keys=%o`,
    latestMessages.length,
    Object.keys(context.get().dbMessagesMap),
  );

  // Get updated assistant message to extract usage/cost information
  const assistantMessage = latestMessages.find((m) => m.id === assistantMessageId);

  const toolCalls = tools || [];

  // Log llm result
  if (content) {
    log(`[${sessionLogId}][content]`, content);
  }
  if (assistantMessage?.reasoning?.content) {
    log(`[${sessionLogId}][reasoning]`, assistantMessage.reasoning.content);
  }
  if (toolCalls.length > 0) {
    log(`[${sessionLogId}][toolsCalling] `, toolCalls);
  }

  // Log usage
  if (currentStepUsage) {
    log(`[${sessionLogId}][usage] %O`, currentStepUsage);
  }

  log(
    '[%s:%d] call_llm completed, finishType: %s, outputMessages: %d',
    state.operationId,
    state.stepCount,
    finishType,
    latestMessages.length,
  );

  // Accumulate usage and cost to state
  const newState = { ...state, messages: latestMessages };

  if (currentStepUsage) {
    // Use UsageCounter to accumulate LLM usage and cost
    const { usage, cost } = UsageCounter.accumulateLLM({
      cost: state.cost,
      model: llmPayload.model,
      modelUsage: currentStepUsage,
      provider: llmPayload.provider,
      usage: state.usage,
    });

    newState.usage = usage;
    if (cost) newState.cost = cost;
  }

  // If operation was aborted, enter human_abort phase to let agent decide how to handle
  if (finishType === 'abort') {
    log(
      '[%s:%d] call_llm aborted by user, entering human_abort phase',
      state.operationId,
      state.stepCount,
    );

    return {
      events: [],
      newState,
      nextContext: {
        payload: {
          reason: 'user_cancelled',
          parentMessageId: assistantMessageId,
          hasToolsCalling: isFunctionCall,
          toolsCalling: toolCalls,
          result: { content, tool_calls },
        },
        phase: 'human_abort',
        session: {
          messageCount: newState.messages.length,
          sessionId: state.operationId,
          status: 'running',
          stepCount: state.stepCount + 1,
        },
      } as AgentRuntimeContext,
    };
  }

  return {
    events: [],
    newState,
    nextContext: {
      payload: {
        hasToolsCalling: isFunctionCall,
        parentMessageId: assistantMessageId,
        result: { content, tool_calls },
        toolsCalling: toolCalls,
      } as GeneralAgentCallLLMResultPayload,
      phase: 'llm_result',
      session: {
        messageCount: newState.messages.length,
        sessionId: state.operationId,
        status: 'running',
        stepCount: state.stepCount + 1,
      },
      stepUsage: currentStepUsage,
    } as AgentRuntimeContext,
  };
};
