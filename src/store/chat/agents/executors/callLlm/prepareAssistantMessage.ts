import type { GeneralAgentCallLLMInstructionPayload } from '@lobechat/agent-runtime';
import { type CreateMessageParams } from '@lobechat/types';

import { LOADING_FLAT } from '@/const/message';

import type { AgentExecutorContext } from '../shared';
import type { SkipCreateMessageLatch } from './types';

interface PrepareAssistantMessageParams {
  context: AgentExecutorContext;
  llmPayload: GeneralAgentCallLLMInstructionPayload;
  skipCreateMessage: SkipCreateMessageLatch;
}

/**
 * Resolves the assistant message this turn streams into, creating it when needed.
 *
 * Deliberately NOT `async`: the skip branch had no `await` when this lived inline, and
 * returning a promise there would push the rest of the turn behind a microtask, letting a
 * same-tick second invocation start its work first. The caller only awaits the create path.
 */
export const prepareAssistantMessage = ({
  context,
  llmPayload,
  skipCreateMessage,
}: PrepareAssistantMessageParams): Promise<string> | string => {
  // Check if we should skip message creation:
  // - shouldSkipCreateMessage is true (e.g., regenerate mode)
  // - BUT if createAssistantMessage is explicitly true, always create new message
  //   (e.g., after compression we need a new assistant message)
  if (skipCreateMessage.value && !llmPayload.createAssistantMessage) {
    // Skip first creation, subsequent calls will not skip
    skipCreateMessage.value = false;
    return context.parentId;
  }

  return createAssistantMessage({ context, llmPayload });
};

/** Runs synchronously up to the `optimisticCreateMessage` await, so the
 * `llmPayload.parentMessageId` backfill still lands in the caller's tick. */
const createAssistantMessage = async ({
  context,
  llmPayload,
}: Omit<PrepareAssistantMessageParams, 'skipCreateMessage'>): Promise<string> => {
  // Get context from operation
  const opContext = context.getOperationContext();
  // Get effective agentId (depends on scope)
  const effectiveAgentId = context.getEffectiveAgentId();
  // Get subAgentId metadata (for sub_agent scope)
  const subAgentMetadata = context.getMetadataForSubAgent();

  // If this is the first regenerated creation of userMessage, llmPayload doesn't have parentMessageId
  // So we assign it this way
  // TODO: Maybe this should be implemented with an init method in the future
  if (!llmPayload.parentMessageId) {
    llmPayload.parentMessageId = context.parentId;
  }

  // Build metadata
  const metadata: NonNullable<CreateMessageParams['metadata']> = {};
  if (opContext.isSupervisor) {
    metadata.isSupervisor = true;
  }
  if (subAgentMetadata) {
    // Store subAgentId and scope in metadata for sub_agent mode
    // This will be used by conversation-flow to transform agentId for display
    Object.assign(metadata, subAgentMetadata);
  }

  // Create assistant message (following server-side pattern)
  const assistantMessageItem = await context.get().optimisticCreateMessage(
    {
      content: LOADING_FLAT,
      groupId: opContext.groupId,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      model: llmPayload.model,
      parentId: llmPayload.parentMessageId,
      provider: llmPayload.provider,
      role: 'assistant',
      agentId: effectiveAgentId!,
      threadId: opContext.threadId,
      topicId: opContext.topicId ?? undefined,
    },
    { operationId: context.operationId },
  );

  if (!assistantMessageItem) {
    throw new Error('Failed to create assistant message');
  }
  const assistantMessageId = assistantMessageItem.id;

  // Associate the assistant message with the operation for UI loading states
  context.get().associateMessageWithOperation(assistantMessageId, context.operationId);

  return assistantMessageId;
};
