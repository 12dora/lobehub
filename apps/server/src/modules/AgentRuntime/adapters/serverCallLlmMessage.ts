import type { AgentState, CallLLMPayload } from '@lobechat/agent-runtime';

import type { RuntimeExecutorContext } from '../context';
import { log } from '../executorHelpers';
import { formatErrorEventData } from '../formatErrorEventData';
import { createConversationParentMissingError } from '../messagePersistErrors';
import { resolveAssistantMessageId } from './serverCallLlmPayload';

interface PrepareAssistantMessageInput {
  ctx: RuntimeExecutorContext;
  llmPayload: CallLLMPayload;
  model: string;
  parentId?: string;
  preparedAssistantMessage?: { id: string };
  provider: string;
  stagePrefix: string;
  state: AgentState;
}

export interface PreparedAssistantMessage {
  item: { id: string };
  seed?: Record<string, unknown>;
}

export const assertCallLlmParentExists = async (
  ctx: RuntimeExecutorContext,
  parentId: string | undefined,
  isPrepared: boolean,
) => {
  if (isPrepared || !parentId) return;

  // Fail before spending tokens when a concurrent topic deletion has removed
  // the parent; otherwise assistant creation would surface only a raw FK error.
  const parentExists = await ctx.messageModel.findById(parentId);
  if (parentExists) return;

  const error = createConversationParentMissingError(parentId);
  await ctx.streamManager.publishStreamEvent(ctx.operationId, {
    data: formatErrorEventData(error, 'parent_message_preflight'),
    stepIndex: ctx.stepIndex,
    type: 'error',
  });
  throw error;
};

export const prepareAssistantMessage = async ({
  ctx,
  llmPayload,
  model,
  parentId,
  preparedAssistantMessage,
  provider,
  stagePrefix,
  state,
}: PrepareAssistantMessageInput): Promise<PreparedAssistantMessage> => {
  if (preparedAssistantMessage) {
    log(`${stagePrefix} Using prepared assistant message: %s`, preparedAssistantMessage.id);
    return { item: preparedAssistantMessage };
  }

  const existingAssistantMessageId = resolveAssistantMessageId(llmPayload);
  if (existingAssistantMessageId) {
    log(`${stagePrefix} Using existing assistant message: %s`, existingAssistantMessageId);
    const existingRow = await ctx.messageModel.findById(existingAssistantMessageId);
    return {
      item: { id: existingAssistantMessageId },
      seed: existingRow ?? undefined,
    };
  }

  // The stream_start snapshot was resolved before this row existed, so the
  // seed is the client's only way to insert the message before chunks arrive.
  const item = await ctx.messageModel.create({
    agentId: state.metadata!.agentId!,
    content: '',
    groupId: state.metadata?.groupId ?? undefined,
    model,
    parentId,
    provider,
    role: 'assistant',
    threadId: state.metadata?.threadId,
    topicId: state.metadata?.topicId,
  });
  log(`${stagePrefix} Created new assistant message: %s`, item.id);
  return { item, seed: { ...item } };
};

export const publishCallLlmStreamStart = async ({
  assistantMessage,
  ctx,
  model,
  provider,
  stepLabel,
}: {
  assistantMessage: PreparedAssistantMessage;
  ctx: RuntimeExecutorContext;
  model: string;
  provider: string;
  stepLabel?: string;
}) => {
  const { item, seed } = assistantMessage;
  await ctx.streamManager.publishStreamEvent(ctx.operationId, {
    data: {
      // Only the seed fields the client needs — not the whole DB row.
      assistantMessage: {
        id: item.id,
        ...(seed && {
          agentId: seed.agentId,
          groupId: seed.groupId,
          model: seed.model,
          parentId: seed.parentId,
          provider: seed.provider,
          role: seed.role,
          threadId: seed.threadId,
          topicId: seed.topicId,
        }),
      },
      model,
      provider,
      ...(stepLabel && { stepLabel }),
    },
    stepIndex: ctx.stepIndex,
    type: 'stream_start',
  });
};
