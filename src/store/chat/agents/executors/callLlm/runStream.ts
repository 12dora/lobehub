import type {
  AgentRuntimeContext,
  GeneralAgentCallLLMInstructionPayload,
} from '@lobechat/agent-runtime';
import { TraceNameMap } from '@lobechat/types';

import { chatService } from '@/services/chat';

import type { StreamingHandler } from '../../StreamingHandler';
import { type StreamChunk } from '../../types/streaming';
import type { AgentExecutorContext } from '../shared';
import { handleStreamFinish } from './handleFinish';
import { localizeError } from './localizeError';
import type { CallLlmRuntime } from './resolveRuntime';
import type { CallLlmStreamOutcome } from './types';

interface RunAssistantMessageStreamParams {
  assistantMessageId: string;
  context: AgentExecutorContext;
  handler: StreamingHandler;
  llmPayload: GeneralAgentCallLLMInstructionPayload;
  outcome: CallLlmStreamOutcome;
  runtime: CallLlmRuntime;
  runtimeContext: AgentRuntimeContext | undefined;
}

/** Runs the model-runtime stream, feeding chunks into `handler` until it settles. */
export const runAssistantMessageStream = async ({
  assistantMessageId,
  context,
  handler,
  llmPayload,
  outcome,
  runtime,
  runtimeContext,
}: RunAssistantMessageStreamParams) => {
  const {
    abortController,
    agentConfigData,
    agentId,
    groupId,
    operation,
    resolvedAgentConfig,
    topicId,
    traceId,
  } = runtime;

  const messages = llmPayload.messages.filter((message) => message.id !== assistantMessageId);

  await chatService.createAssistantMessageStream({
    abortController,
    params: {
      agentId: agentId || undefined,
      groupId,
      messages,
      model: llmPayload.model,
      provider: llmPayload.provider,
      platformSkillSnapshot: operation.metadata?.platformSkillSnapshot,
      resolvedAgentConfig,
      topicId: topicId ?? undefined,
      ...agentConfigData.params,
    },
    initialContext: runtimeContext?.initialContext,
    metadata: context.metadata,
    stepContext: runtimeContext?.stepContext,
    trace: {
      traceId,
      topicId: topicId ?? undefined,
      traceName: TraceNameMap.Conversation,
    },
    onErrorHandle: async (error) => {
      const enrichedError = {
        ...error,
        body: {
          ...error.body,
          traceId: traceId ?? error.body?.traceId,
        },
      };
      const localizedError = localizeError(enrichedError);

      await context.get().optimisticUpdateMessageError(assistantMessageId, localizedError, {
        operationId: context.operationId,
      });
    },
    onFinish: async (_content, finishContext) => {
      void _content;

      await handleStreamFinish({
        assistantMessageId,
        context,
        finishContext,
        handler,
        outcome,
        runtime,
      });
    },
    onMessageHandle: async (chunk) => {
      handler.handleChunk(chunk as StreamChunk);
    },
  });
};
