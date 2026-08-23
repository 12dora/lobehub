import type { FileRenderMetadata, FileRenderTextIndex } from '@lobechat/types';
import type { OwnDeploymentOrigins } from '@lobechat/utils';

import type { LobeChatDatabase } from '@/database/type';

export interface OwnOriginAttachmentBytes {
  bytes: Uint8Array;
  mimeType: string;
}

export type OwnOriginAttachmentResolver = (
  url: string,
  maxBytes: number,
) => Promise<OwnOriginAttachmentBytes | null>;

export type OwnOriginFileIdResolver = (
  fileId: string,
  maxBytes: number,
) => Promise<OwnOriginAttachmentBytes | null>;

type MaybeLazy<T> = T | Promise<T> | (() => T | Promise<T>);

export interface CreateOwnOriginAttachmentInlineHooksInput {
  db?: MaybeLazy<LobeChatDatabase>;
  /**
   * Per-provider image inlining cap. Cursor's CLI transport rejects images
   * above 6 MiB; other providers use `DEFAULT_IMAGE_INLINE_MAX_BYTES`.
   */
  imageMaxBytes?: number;
  /**
   * Per-message rasterized PDF image ceiling. Cursor's CLI transport rejects
   * more than 4 images; other providers use 6 (page + four quadrant tiles).
   * Admin `maxImagesDefault` is applied via `resolveFeedLimits` as
   * `min(provider cap, settings.maxImagesDefault)`.
   */
  imageMaxCount?: number;
  maxDocsPerRequest?: number;
  ownOrigins: MaybeLazy<OwnDeploymentOrigins>;
  /** Admin document-render budgets; resolved lazily on the first payload with candidates. */
  resolveFeedLimits?: () => Promise<{
    imageMaxCount: number;
    maxDocsPerRequest: number;
  }>;
  /** When false (Cursor), document-feed notices tell the model to name pages. */
  tools?: boolean;
  userId?: string;
}

export interface InlineOwnOriginAttachmentsOptions {
  /** Ownership check for tool-result file ids (scoped FileModel lookup). */
  authorizeFile?: (fileId: string) => Promise<boolean>;
  fileMaxBytes?: number;
  imageMaxBytes?: number;
  imageMaxCount?: number;
  /** Load a render artifact PNG by object key (FileService.getFileByteArray). */
  loadArtifact?: (key: string, fileId: string) => Promise<Uint8Array | null>;
  /** files.metadata.render for an attached file id. */
  loadRender?: (fileId: string) => Promise<FileRenderMetadata | undefined>;
  /** `text/index.json` body for relevance-ranked page selection. */
  loadTextIndex?: (fileId: string, key: string) => Promise<FileRenderTextIndex | undefined>;
  maxDocsPerRequest?: number;
  /** Resolves a `files` row by id (FileModel + FileService). Used for `<files_info>` PDFs. */
  resolveByFileId?: OwnOriginFileIdResolver;
  tools?: boolean;
}
