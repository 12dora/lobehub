import { DocumentPagesExecutionRuntime } from '@lobechat/builtin-tool-document-pages/executionRuntime';
import { DocumentPagesIdentifier } from '@lobechat/builtin-tool-document-pages/manifest';

import { FileModel } from '@/database/models/file';

import { type ServerRuntimeRegistration } from './types';

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

    return new DocumentPagesExecutionRuntime({
      enqueueRender: async (fileId) => {
        // Relative import: this runtime is not an enterprise mount point, so
        // `@/server/enterprise/...` is forbidden by pathBoundaries. S2 owns the
        // barrel at apps/server/src/enterprise/services/documentRender.
        const { enqueueDocumentRenderJob } = await import(
          '@/server/enterprise/services/documentRender'
        );
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
