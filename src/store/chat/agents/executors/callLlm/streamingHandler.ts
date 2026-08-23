import { t } from 'i18next';

import { message as antdMessage } from '@/components/AntdStaticMethods';
import { getFileStoreState } from '@/store/file/store';

import { StreamingHandler } from '../../StreamingHandler';
import type { AgentExecutorContext } from '../shared';
import type { CallLlmRuntime } from './resolveRuntime';

interface CreateCallLlmStreamingHandlerParams {
  assistantMessageId: string;
  context: AgentExecutorContext;
  runtime: CallLlmRuntime;
}

/** Create streaming handler with callbacks */
export const createCallLlmStreamingHandler = ({
  assistantMessageId,
  context,
  runtime,
}: CreateCallLlmStreamingHandlerParams): StreamingHandler => {
  const {
    abortController,
    agentId,
    fetchContext,
    groupId,
    internal_dispatchMessage,
    internal_toggleToolCallingStreaming,
    offeredToolNames,
    topicId,
  } = runtime;

  return new StreamingHandler(
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
};
