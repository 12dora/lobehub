import type {
  AgentEvent,
  AgentInstructionCompressContext,
  AgentRuntimeContext,
  GeneralAgentCompressionResultPayload,
  InstructionExecutor,
} from '@lobechat/agent-runtime';
import { countContextTokens } from '@lobechat/context-engine';
import { chainCompressContext } from '@lobechat/prompts';

import { chatService } from '@/services/chat';
import { messageService } from '@/services/message';
import { getCompressionCandidateMessageIds } from '@/store/chat/utils/compression';

import type { AgentExecutorContext } from './shared';
import { log } from './shared';

const isAbortError = (error: unknown, abortController?: AbortController) =>
  !!abortController?.signal.aborted ||
  (error instanceof Error &&
    (error.name === 'AbortError' ||
      error.message.includes('aborted') ||
      error.message.includes('cancelled')));

const createAbortError = () =>
  Object.assign(new Error('Compression cancelled'), { name: 'AbortError' });

/** Compresses messages into a summary group. */
export const createCompressContextExecutor = (
  context: AgentExecutorContext,
): InstructionExecutor => {
  return async (instruction, state) => {
    const sessionLogId = `${state.operationId}:${state.stepCount}`;
    const stagePrefix = `[${sessionLogId}][compress_context]`;

    const { messages, currentTokenCount } = (instruction as AgentInstructionCompressContext)
      .payload;

    // Get topicId from operation context (same as agentId)
    const { topicId } = context.getOperationContext();

    log(
      `${stagePrefix} Starting compression. displayMessages=%d, tokens=%d`,
      messages.length,
      currentTokenCount,
    );

    const events: AgentEvent[] = [];

    // Get message IDs from dbMessagesMap (raw db messages)
    const dbMessages = context.get().dbMessagesMap[context.messageKey] || [];
    const messageIds = getCompressionCandidateMessageIds(dbMessages);

    if (!topicId || messageIds.length === 0) {
      // No topicId or no messages, skip compression
      log(
        `${stagePrefix} Skipping compression: topicId=%s, messageIds=%d`,
        topicId,
        messageIds.length,
      );
      return {
        events: [],
        newState: state,
        nextContext: {
          payload: {
            compressedMessages: messages,
            compressedTokenCount: currentTokenCount,
            groupId: '',
            originalTokenCount: currentTokenCount,
            skipped: true,
          } as GeneralAgentCompressionResultPayload,
          phase: 'compression_result',
          session: {
            messageCount: state.messages.length,
            sessionId: state.operationId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
        } as AgentRuntimeContext,
      };
    }

    // Find the latest assistant message to attach the compression operation
    const latestAssistantMessage = dbMessages.findLast((m) => m.role === 'assistant');
    const assistantMessageId = latestAssistantMessage?.id;

    log(
      `${stagePrefix} Compressing %d db messages (display: %d), assistantMsgId=%s`,
      messageIds.length,
      messages.length,
      assistantMessageId,
    );

    // Create compress_context operation and attach to the assistant message
    const { operationId: compressOperationId } = context.get().startOperation({
      context: { ...context.getOperationContext(), messageId: assistantMessageId },
      metadata: {
        messageCount: messageIds.length,
        startTime: Date.now(),
      },
      parentOperationId: state.operationId,
      type: 'contextCompression',
    });

    try {
      const opContext = context.getOperationContext();
      // agentId is guaranteed to exist in compression context
      const agentId = context.getEffectiveAgentId()!;

      // 1. Create compression group with placeholder content
      const result = await messageService.createCompressionGroup({
        agentId,
        messageIds,
        topicId,
      });
      const { messageGroupId, messages: initialCompressedMessages, messagesToSummarize } = result;

      // 2. Update UI with compressed messages immediately
      context.get().replaceMessages(initialCompressedMessages, { context: opContext });

      // 3. Get model/provider from compressionModel config
      const { model, provider } = state.modelRuntimeConfig?.compressionModel || {};

      log(
        `${stagePrefix} Created group=%s, generating summary for %d messages by %s`,
        messageGroupId,
        messagesToSummarize.length,
        `${provider}/${model}`,
      );

      // 4. Build compression prompt and generate summary with streaming UI updates
      const compressionPayload = chainCompressContext(messagesToSummarize);
      let summaryContent = '';

      // Start generateSummary operation attached to the compressed group message
      const { abortController: summaryAbortController, operationId: summaryOperationId } = context
        .get()
        .startOperation({
          context: { ...context.getOperationContext(), messageId: messageGroupId },
          type: 'generateSummary',
          parentOperationId: compressOperationId,
        });

      await chatService.fetchPresetTaskResult({
        abortController: summaryAbortController,
        params: { ...compressionPayload, model, provider },
        onMessageHandle: (chunk) => {
          if (chunk.type === 'text') {
            summaryContent += chunk.text || '';
            // Stream update the compression group message content
            context
              .get()
              .internal_dispatchMessage(
                { id: messageGroupId, type: 'updateMessage', value: { content: summaryContent } },
                { operationId: summaryOperationId },
              );
          }
        },
        onError: (e) => {
          console.error(e);
          context.get().completeOperation(summaryOperationId, {
            error: { message: String(e), type: 'summary_generation_failed' },
          });
        },
      });

      if (summaryAbortController.signal.aborted) throw createAbortError();

      log(`${stagePrefix} Generated summary: %d chars`, summaryContent.length);

      // 5. Finalize compression with actual content
      const finalResult = await messageService.finalizeCompression({
        agentId,
        content: summaryContent,
        messageGroupId,
        topicId,
      });
      // Complete the generateSummary operation
      context.get().completeOperation(summaryOperationId);

      const compressedMessages = finalResult.messages || initialCompressedMessages;
      const groupId = messageGroupId;
      // Use the latest assistant message ID (before compression) as parentMessageId for next call_llm
      const parentMessageId = assistantMessageId;

      // 6. Update UI with finalized messages (includes compressedGroup with summary)
      context.get().replaceMessages(compressedMessages, { context: opContext });

      log(
        `${stagePrefix} Compression complete. groupId=%s, parentMessageId=%s`,
        groupId,
        parentMessageId,
      );

      // Complete the compress_context operation
      context.get().completeOperation(compressOperationId, { groupId, parentMessageId });

      events.push({ type: 'compression_complete', groupId, parentMessageId });

      // Calculate new token count
      const compressedTokenCount = countContextTokens({
        messages: compressedMessages,
      }).rawTotal;

      return {
        events,
        newState: { ...state, messages: compressedMessages },
        nextContext: {
          payload: {
            compressedMessages,
            compressedTokenCount,
            groupId,
            originalTokenCount: currentTokenCount,
            parentMessageId,
          } as GeneralAgentCompressionResultPayload,
          phase: 'compression_result',
          session: {
            messageCount: compressedMessages.length,
            sessionId: state.operationId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
        } as AgentRuntimeContext,
      };
    } catch (error) {
      if (isAbortError(error)) {
        log(`${stagePrefix} Compression cancelled`);

        if (context.get().operations[compressOperationId]?.status === 'running') {
          context.get().completeOperation(compressOperationId, { cancelled: true });
        }

        events.push({ type: 'compression_error', error });

        return {
          events,
          newState: state,
          nextContext: {
            payload: {
              compressedMessages: messages,
              skipped: true,
            } as GeneralAgentCompressionResultPayload,
            phase: 'compression_result',
            session: {
              messageCount: state.messages.length,
              sessionId: state.operationId,
              status: 'running',
              stepCount: state.stepCount + 1,
            },
          } as AgentRuntimeContext,
        };
      }

      log(`${stagePrefix} Compression failed: %O`, error);

      // Complete the compress_context operation with error
      context.get().completeOperation(compressOperationId, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: 'compression_failed',
        },
      });

      // On error, continue without compression
      events.push({ type: 'compression_error', error });

      return {
        events,
        newState: state,
        nextContext: {
          payload: {
            compressedMessages: messages,
            skipped: true,
          } as GeneralAgentCompressionResultPayload,
          phase: 'compression_result',
          session: {
            messageCount: state.messages.length,
            sessionId: state.operationId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
        } as AgentRuntimeContext,
      };
    }
  };
};
