import type {
  AgentInstructionCallLlm,
  AgentRuntimeContext,
  GeneralAgentCallLLMInstructionPayload,
  GeneralAgentCallLLMResultPayload,
  InstructionExecutor,
} from '@lobechat/agent-runtime';
import { UsageCounter } from '@lobechat/agent-runtime';
import {
  type ChatMessageError,
  type CreateMessageParams,
  type MessageToolCall,
  type ModelUsage,
  TraceNameMap,
} from '@lobechat/types';
import { dedupeBy } from '@lobechat/utils';
import { t } from 'i18next';

import { message as antdMessage } from '@/components/AntdStaticMethods';
import { LOADING_FLAT } from '@/const/message';
import { chatService } from '@/services/chat';
import { messageService } from '@/services/message';
import { getFileStoreState } from '@/store/file/store';

import { StreamingHandler } from '../StreamingHandler';
import { type StreamChunk } from '../types/streaming';
import type { AgentExecutorContext } from './shared';
import { log } from './shared';

const getGoogleBlockedReason = (error: ChatMessageError): string | undefined => {
  const body = error.body as
    | {
        context?: {
          finishReason?: unknown;
          promptFeedback?: {
            blockReason?: unknown;
          };
        };
        provider?: unknown;
      }
    | undefined;

  if (body?.provider !== 'google') return undefined;

  const promptFeedbackReason = body.context?.promptFeedback?.blockReason;
  if (typeof promptFeedbackReason === 'string') return promptFeedbackReason;

  const finishReason = body.context?.finishReason;
  if (typeof finishReason === 'string') return finishReason;

  return undefined;
};

const localizeGoogleBlockedError = (error: ChatMessageError): ChatMessageError => {
  const blockReason = getGoogleBlockedReason(error);
  if (!blockReason) return error;

  const translationKey = `response.GoogleAIBlockReason.${blockReason}`;
  const localized = t(translationKey as 'response.GoogleAIBlockReason.default', {
    defaultValue: error.message ?? '',
    ns: 'error',
  }).trim();

  if (!localized || localized === translationKey) return error;

  const normalizedBody =
    error.body && typeof error.body === 'object' ? (error.body as Record<string, unknown>) : {};

  return {
    ...error,
    body: {
      ...normalizedBody,
      message: localized,
    },
    message: localized,
  };
};

const localizeError = (error: ChatMessageError): ChatMessageError => {
  const body = error.body as
    | {
        provider?: unknown;
      }
    | undefined;

  if (body?.provider === 'google') {
    return localizeGoogleBlockedError(error);
  }

  return error;
};

/** Creates assistant messages and streams LLM responses. */
export const createCallLlmExecutor = (context: AgentExecutorContext): InstructionExecutor => {
  let shouldSkipCreateMessage = context.skipCreateFirstMessage;

  return async (instruction, state, runtimeContext) => {
    const sessionLogId = `${state.operationId}:${state.stepCount}`;
    const stagePrefix = `[${sessionLogId}][call_llm]`;

    const llmPayload = (instruction as AgentInstructionCallLlm)
      .payload as GeneralAgentCallLLMInstructionPayload;

    log(
      `${stagePrefix} Starting session. Input: state.messages=%d, llmPayload.messages=%d, messageKey=%s`,
      state.messages.length,
      llmPayload.messages.length,
      context.messageKey,
    );

    let assistantMessageId: string;

    // Check if we should skip message creation:
    // - shouldSkipCreateMessage is true (e.g., regenerate mode)
    // - BUT if createAssistantMessage is explicitly true, always create new message
    //   (e.g., after compression we need a new assistant message)
    if (shouldSkipCreateMessage && !llmPayload.createAssistantMessage) {
      // Skip first creation, subsequent calls will not skip
      assistantMessageId = context.parentId;
      shouldSkipCreateMessage = false;
    } else {
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
      assistantMessageId = assistantMessageItem.id;

      // Associate the assistant message with the operation for UI loading states
      context.get().associateMessageWithOperation(assistantMessageId, context.operationId);
    }

    log(`${stagePrefix} Created assistant message, id: %s`, assistantMessageId);

    log(
      `${stagePrefix} calling model-runtime chat (model: %s, messages: %d, tools: %d)`,
      llmPayload.model,
      llmPayload.messages.length,
      llmPayload.tools?.length ?? 0,
    );

    // ======== Inlined streaming logic (previously internal_fetchAIChatMessage) ========
    const {
      optimisticUpdateMessageContent,
      internal_dispatchMessage,
      internal_toggleToolCallingStreaming,
    } = context.get();

    // Get agentId, topicId, groupId and abortController from operation
    const operation = context.get().operations[context.operationId];
    if (!operation) {
      throw new Error(`Operation not found: ${context.operationId}`);
    }
    const { subAgentId, groupId, topicId } = operation.context;
    const abortController = operation.abortController;

    // In group orchestration, subAgentId is the actual responding agent
    const agentId = groupId && subAgentId ? subAgentId : operation.context.agentId!;

    const traceId = operation.metadata?.traceId;

    const fetchContext = { ...operation.context, agentId };

    const { agentConfig: agentConfigData } = context.agentConfig;

    let finalUsage: ModelUsage | undefined;
    let finalToolCalls: MessageToolCall[] | undefined;

    // Expand dynamically activated tools (from lobe-activator activateTools API)
    // and merge them into the agent config for this LLM call.
    // Built before the StreamingHandler so we can bind the offered tool
    // names into the transformToolCalls callback ().
    const activatedToolIds = runtimeContext?.stepContext?.activatedToolIds;
    let resolvedAgentConfig = context.agentConfig;

    if (activatedToolIds?.length && context.toolsEngine) {
      const additional = context.toolsEngine.generateToolsDetailed({
        context: { isExplicitActivation: true },
        model: agentConfigData.model,
        provider: agentConfigData.provider!,
        skipDefaultTools: true,
        toolIds: activatedToolIds,
      });

      if (additional.tools?.length) {
        const mergedEnabledManifests = dedupeBy(
          [...(context.agentConfig.enabledManifests || []), ...additional.enabledManifests],
          (manifest) => manifest.identifier,
        );
        const mergedEnabledToolIds = [
          ...new Set([...(context.agentConfig.enabledToolIds || []), ...additional.enabledToolIds]),
        ];
        const mergedTools = dedupeBy(
          [...(context.agentConfig.tools || []), ...additional.tools],
          (tool) => tool.function.name,
        );

        resolvedAgentConfig = {
          ...context.agentConfig,
          enabledManifests: mergedEnabledManifests,
          enabledToolIds: mergedEnabledToolIds,
          tools: mergedTools,
        };

        log(
          `${stagePrefix} Injected %d activated tools: %o`,
          activatedToolIds.length,
          activatedToolIds,
        );
      }
    }

    // Names of tools actually sent to the LLM this turn. Passed to the
    // resolver's missing-prefix fallback so a model can't reach tools that
    // weren't enabled, and disabled duplicates can't shadow enabled calls.
    const offeredToolNames = (resolvedAgentConfig.tools ?? []).map((tool) => tool.function.name);

    // Create streaming handler with callbacks
    const handler = new StreamingHandler(
      {
        abortSignal: abortController?.signal,
        messageId: assistantMessageId,
        operationId: context.operationId,
        agentId,
        groupId,
        topicId,
      },
      {
        onContentUpdate: (content, reasoning, contentMetadata) => {
          internal_dispatchMessage(
            {
              id: assistantMessageId,
              type: 'updateMessage',
              value: {
                content,
                reasoning,
                ...(contentMetadata && {
                  metadata: {
                    isMultimodal: contentMetadata.isMultimodal,
                    tempDisplayContent: contentMetadata.tempDisplayContent,
                  },
                }),
              },
            },
            { operationId: context.operationId },
          );
        },
        onReasoningUpdate: (reasoning) => {
          internal_dispatchMessage(
            {
              id: assistantMessageId,
              type: 'updateMessage',
              value: { reasoning },
            },
            { operationId: context.operationId },
          );
        },
        onToolCallsUpdate: (tools) => {
          internal_dispatchMessage(
            {
              id: assistantMessageId,
              type: 'updateMessage',
              value: { tools },
            },
            { operationId: context.operationId },
          );
        },
        onGroundingUpdate: (grounding) => {
          internal_dispatchMessage(
            {
              id: assistantMessageId,
              type: 'updateMessage',
              value: { search: grounding },
            },
            { operationId: context.operationId },
          );
        },
        onImagesUpdate: (images) => {
          internal_dispatchMessage(
            {
              id: assistantMessageId,
              type: 'updateMessage',
              value: { imageList: images },
            },
            { operationId: context.operationId },
          );
        },
        onFilesUpdate: (files) => {
          internal_dispatchMessage(
            {
              id: assistantMessageId,
              type: 'updateMessage',
              value: { fileList: files },
            },
            { operationId: context.operationId },
          );
        },
        onReasoningStart: () => {
          const { operationId: reasoningOpId } = context.get().startOperation({
            type: 'reasoning',
            context: { ...fetchContext, messageId: assistantMessageId },
            parentOperationId: context.operationId,
          });
          context.get().associateMessageWithOperation(assistantMessageId, reasoningOpId);
          return reasoningOpId;
        },
        onReasoningComplete: (opId) => context.get().completeOperation(opId),
        uploadBase64Image: (data) =>
          getFileStoreState()
            .uploadBase64FileWithProgress(data)
            .then((file) => ({
              id: file?.id,
              url: file?.url,
              alt: file?.filename || file?.id,
            })),
        uploadBase64File: (dataUri, { filename, mimeType, signal }) =>
          getFileStoreState()
            .uploadBase64FileWithProgress(dataUri, { filename, mimeType, signal })
            .then((file) => (file?.id && file?.url ? { id: file.id, url: file.url } : undefined)),
        onFileUploadError: ({ name }) => {
          antdMessage.error(t('generatedFileUploadFailed', { name, ns: 'chat' }));
        },
        transformToolCalls: (calls) =>
          context.get().internal_transformToolCalls(calls, offeredToolNames),
        toggleToolCallingStreaming: internal_toggleToolCallingStreaming,
      },
    );

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
      onFinish: async (
        _content,
        {
          traceId,
          observationId,
          toolCalls,
          reasoning,
          grounding,
          moderation,
          usage,
          speed,
          type,
          finishReason,
        },
      ) => {
        void _content;

        if (traceId) {
          messageService.updateMessage(
            assistantMessageId,
            { traceId, observationId: observationId ?? undefined },
            { agentId, groupId, topicId },
          );
        }

        const result = await handler.handleFinish({
          traceId,
          observationId,
          toolCalls,
          reasoning,
          grounding,
          usage,
          speed,
          type,
          finishReason,
        });

        finalUsage = result.usage;
        finalToolCalls = result.toolCalls;

        // Attach generated (non-image) files to the assistant message. This
        // inserts the `messages_files` rows, so the subsequent updateMessage
        // response comes back with a hydrated `fileList`. Never fail the
        // answer because of it.
        const generatedFiles = result.metadata.fileList ?? [];
        // The server answers `{ success: false }` when the DB write fails —
        // it does NOT reject — so a resolved promise is not proof of success.
        let filesAttached = generatedFiles.length === 0;

        if (generatedFiles.length > 0) {
          try {
            const attachResult = await messageService.addFilesToMessage(
              assistantMessageId,
              generatedFiles.map((file) => file.id),
              { agentId, groupId, topicId },
            );
            filesAttached = !!attachResult?.success;

            if (!filesAttached) {
              log(
                '[file] addFilesToMessage returned success=false messageId=%s, files=%d',
                assistantMessageId,
                generatedFiles.length,
              );
            }
          } catch (error) {
            log(
              '[file] failed to attach generated files messageId=%s, error=%o',
              assistantMessageId,
              error,
            );
          }

          if (!filesAttached) {
            antdMessage.error(t('fileAttachFailed', { ns: 'chat' }));
          }
        }

        await optimisticUpdateMessageContent(
          assistantMessageId,
          result.content,
          {
            tools: result.tools,
            reasoning: result.metadata.reasoning,
            search: result.metadata.search,
            imageList: result.metadata.imageList,
            metadata: {
              ...result.metadata.usage,
              ...result.metadata.performance,
              performance: result.metadata.performance,
              usage: result.metadata.usage,
              finishType: result.metadata.finishType,
              ...(result.metadata.finishReason && { finishReason: result.metadata.finishReason }),
              ...(result.metadata.isMultimodal && { isMultimodal: true }),
              // 内容审计 downgrade: persist the notice with the message so it survives a reload.
              ...(moderation && { moderation }),
            },
            // The reply came from the fallback model, so the message must report that model /
            // provider — not the one the user picked (design §3.6).
            ...(moderation && { model: moderation.model, provider: moderation.provider }),
          },
          { operationId: context.operationId },
        );

        // `optimisticUpdateMessageContent` replaces the message with the DB
        // rows, which have no `messages_files` link when the attach failed.
        // The files themselves were uploaded fine, so keep the cards instead
        // of letting them silently disappear.
        if (!filesAttached) {
          internal_dispatchMessage(
            {
              id: assistantMessageId,
              type: 'updateMessage',
              value: { fileList: generatedFiles },
            },
            { operationId: context.operationId },
          );
        }
      },
      onMessageHandle: async (chunk) => {
        handler.handleChunk(chunk as StreamChunk);
      },
    });

    const isFunctionCall = handler.getIsFunctionCall();
    const content = handler.getOutput();
    const tools = handler.getTools();
    const currentStepUsage = finalUsage;
    const tool_calls = finalToolCalls;
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
};
