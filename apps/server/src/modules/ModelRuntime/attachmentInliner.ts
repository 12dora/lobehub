import type { ModelRuntimeHooks } from '@lobechat/model-runtime';
import { DOCUMENT_RENDER_DEFAULTS } from '@lobechat/types';
import { DEFAULT_IMAGE_INLINE_MAX_BYTES } from '@lobechat/utils/imageToBase64';
import debug from 'debug';

import { IMAGE_ONLY_PDF_MAX_IMAGES_PER_MESSAGE } from './attachmentInlinerPdf';
import { inlineOwnOriginAttachments } from './attachmentInlinerPipeline';
import { createFileServiceResolvers } from './attachmentInlinerResolvers';
import type { CreateOwnOriginAttachmentInlineHooksInput } from './attachmentInlinerTypes';
import {
  hasAttachmentCandidates,
  inlineOwnOriginImageUrls,
  isDataUri,
} from './attachmentInlinerUrls';

export { inlineOwnOriginAttachments } from './attachmentInlinerPipeline';
export type {
  CreateOwnOriginAttachmentInlineHooksInput,
  InlineOwnOriginAttachmentsOptions,
  OwnOriginAttachmentBytes,
  OwnOriginAttachmentResolver,
  OwnOriginFileIdResolver,
} from './attachmentInlinerTypes';
export { inlineOwnOriginImageUrls } from './attachmentInlinerUrls';

const log = debug('lobe-server:attachment-inliner');

const resolveMaybeLazy = async <T>(value: T | Promise<T> | (() => T | Promise<T>)): Promise<T> =>
  typeof value === 'function' ? (value as () => T | Promise<T>)() : value;

export const createOwnOriginAttachmentInlineHooks = (
  input: CreateOwnOriginAttachmentInlineHooksInput,
): ModelRuntimeHooks => {
  const imageMaxBytes = input.imageMaxBytes ?? DEFAULT_IMAGE_INLINE_MAX_BYTES;
  const tools = input.tools ?? true;

  const resolveLimits = async () => {
    const fallback = {
      imageMaxCount: input.imageMaxCount ?? IMAGE_ONLY_PDF_MAX_IMAGES_PER_MESSAGE,
      maxDocsPerRequest: input.maxDocsPerRequest ?? DOCUMENT_RENDER_DEFAULTS.maxDocsPerRequest,
    };
    if (!input.resolveFeedLimits) return fallback;
    try {
      return await input.resolveFeedLimits();
    } catch (error) {
      log('feed limits failed: %s', error instanceof Error ? error.message : error);
      console.error('document-render feed limits failed', error);
      return fallback;
    }
  };

  return {
    beforeChat: async (payload) => {
      try {
        if (!payload.messages?.length || !hasAttachmentCandidates(payload.messages)) return;

        const limits = await resolveLimits();
        const origins = await resolveMaybeLazy(input.ownOrigins);
        const resolvers = createFileServiceResolvers(input, origins);
        await inlineOwnOriginAttachments(payload.messages, resolvers.resolveByUrl, origins, {
          authorizeFile: resolvers.authorizeFile,
          imageMaxBytes,
          imageMaxCount: limits.imageMaxCount,
          loadArtifact: resolvers.loadArtifact,
          loadRender: resolvers.loadRender,
          loadTextIndex: resolvers.loadTextIndex,
          maxDocsPerRequest: limits.maxDocsPerRequest,
          resolveByFileId: resolvers.resolveByFileId,
          tools,
        });
      } catch (error) {
        log(
          'own-origin attachment inline failed: %s',
          error instanceof Error ? error.message : error,
        );
      }
    },
    beforeCreateImage: async (payload) => {
      try {
        const urls = payload.params.imageUrls;
        if (!urls?.some((url) => typeof url === 'string' && !isDataUri(url))) return;

        const origins = await resolveMaybeLazy(input.ownOrigins);
        payload.params.imageUrls = await inlineOwnOriginImageUrls(
          urls,
          createFileServiceResolvers(input, origins).resolveByUrl,
          origins,
          imageMaxBytes,
        );
      } catch (error) {
        log(
          'own-origin imageUrls inline failed: %s',
          error instanceof Error ? error.message : error,
        );
      }
    },
  };
};
