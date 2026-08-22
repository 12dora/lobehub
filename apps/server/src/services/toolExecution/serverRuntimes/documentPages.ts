import {
  createDocumentPagesCallBudget,
  DOCUMENT_PAGES_CALL_BUDGET_TTL_MS,
  DOCUMENT_PAGES_CALL_LIMIT,
  DocumentPagesExecutionRuntime,
} from '@lobechat/builtin-tool-document-pages/executionRuntime';
import { DocumentPagesIdentifier } from '@lobechat/builtin-tool-document-pages/manifest';

import { FileModel } from '@/database/models/file';

import type { ToolExecutionContext } from '../types';
import type { ServerRuntimeRegistration } from './types';

/**
 * Narrowest stable id for an assistant turn. `assistantMessageId` is the
 * assistant message that carries this turn's tool calls (set by
 * ServerToolTransport from `parentMessageId`). `operationId` spans the whole
 * agent loop, so it is only a fallback. A per-(userId, topicId) key is last
 * resort and relies on the 60s TTL as a sliding window.
 */
export const resolveDocumentPagesCallBudgetKey = (
  context: ToolExecutionContext,
): string | undefined => {
  if (context.assistantMessageId) return `turn:${context.assistantMessageId}`;
  if (context.operationId) return `op:${context.operationId}`;
  if (context.userId && context.topicId) return `topic:${context.userId}:${context.topicId}`;
  return undefined;
};

export const documentPagesRuntime: ServerRuntimeRegistration = {
  factory: (context) => {
    if (!context.serverDB) {
      throw new Error('serverDB is required for Document Pages execution');
    }
    if (!context.userId) {
      throw new Error('userId is required for Document Pages execution');
    }

    const { serverDB, userId, workspaceId } = context;
    const fileModel = new FileModel(serverDB, userId, workspaceId);
    const callBudgetKey = resolveDocumentPagesCallBudgetKey(context);

    return new DocumentPagesExecutionRuntime({
      callBudget: callBudgetKey
        ? createDocumentPagesCallBudget({
            limit: DOCUMENT_PAGES_CALL_LIMIT,
            ttlMs: DOCUMENT_PAGES_CALL_BUDGET_TTL_MS,
          })
        : undefined,
      callBudgetKey,
      enqueueRender: async (fileId) => {
        // Relative import: this runtime is not an enterprise mount point, so
        // `@/server/enterprise/...` is forbidden by pathBoundaries. S2 owns the
        // barrel at apps/server/src/enterprise/services/documentRender.
        const { enqueueDocumentRenderJob } =
          await import('@/server/enterprise/services/documentRender');
        return enqueueDocumentRenderJob(serverDB, { fileId, force: true });
      },
      findAccessibleFile: async (fileId) => {
        const file = await fileModel.findById(fileId);
        if (!file) return undefined;
        return {
          fileType: file.fileType,
          id: file.id,
          metadata: file.metadata,
          name: file.name,
        };
      },
    });
  },
  identifier: DocumentPagesIdentifier,
};
