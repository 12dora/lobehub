import type { OnFinishHandler } from '@lobechat/fetch-sse';
import { t } from 'i18next';

import { message as antdMessage } from '@/components/AntdStaticMethods';
import { messageService } from '@/services/message';

import type { StreamingHandler } from '../../StreamingHandler';
import type { AgentExecutorContext } from '../shared';
import { log } from '../shared';
import type { CallLlmRuntime } from './resolveRuntime';
import type { CallLlmStreamOutcome } from './types';

type StreamFinishContext = Parameters<OnFinishHandler>[1];

interface HandleStreamFinishParams {
  assistantMessageId: string;
  context: AgentExecutorContext;
  finishContext: StreamFinishContext;
  handler: StreamingHandler;
  outcome: CallLlmStreamOutcome;
  runtime: CallLlmRuntime;
}

/** Persists the finished assistant answer and records its usage into `outcome`. */
export const handleStreamFinish = async ({
  assistantMessageId,
  context,
  finishContext,
  handler,
  outcome,
  runtime,
}: HandleStreamFinishParams) => {
  const {
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
  } = finishContext;

  const { agentId, groupId, internal_dispatchMessage, optimisticUpdateMessageContent, topicId } =
    runtime;

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

  outcome.usage = result.usage;
  outcome.toolCalls = result.toolCalls;

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
};
