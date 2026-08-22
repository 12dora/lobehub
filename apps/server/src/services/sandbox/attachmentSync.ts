import {
  CloudSandboxIdentifier,
  SANDBOX_INIT_MAX_FILE_SIZE,
} from '@lobechat/builtin-tool-cloud-sandbox';
import type { ChatFileItem } from '@lobechat/types';
import { DEFAULT_FILE_INLINE_MAX_BYTES } from '@lobechat/utils';
import debug from 'debug';

import { SANDBOX_ATTACHMENT_SYNC_CONCURRENCY } from './bootstrap';
import { mapWithConcurrency } from './pool';
import type { SandboxOverLimitAttachment } from './types';

const log = debug('lobe-server:sandbox:attachmentSync');

/**
 * Document types the Responses `input_file` path can inline. Mirrors the
 * runtime check in `packages/model-runtime/src/core/contextBuilders/openai.ts`.
 * Used by {@link isAttachmentNotDeliveredNatively} (caller-side native vs
 * sandbox-only split); selection itself syncs every attachment.
 */
const DOCUMENT_MIME_TYPES = new Set([
  'application/json',
  'application/msword',
  'application/pdf',
  'application/rtf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/xml',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/xml',
]);

const DOCUMENT_EXTENSIONS = new Set([
  'csv',
  'doc',
  'docx',
  'htm',
  'html',
  'json',
  'md',
  'pdf',
  'ppt',
  'pptx',
  'rtf',
  'txt',
  'xls',
  'xlsx',
  'xml',
]);

export interface SandboxAttachmentToSync {
  fileType?: string;
  id: string;
  name: string;
  size?: number;
  url: string;
}

export interface SyncSandboxAttachmentsResult {
  /** Every file selected for sandbox sync (success and failure). */
  attemptedFileIds: string[];
  /** file id → collision-free `/mnt/data/uploads/...` path for successful syncs. */
  sandboxPathByFileId: Record<string, string>;
}

export interface SyncSandboxAttachmentsDeps {
  /**
   * Dedicated sandbox download (must skip topic-file bootstrap). Receives
   * already-presigned URLs plus the original storage key for the local push path.
   */
  downloadFiles: (files: SandboxOverLimitAttachment[]) => Promise<Record<string, string>>;
  resolveDownloadUrl?: (storageUrl: string) => Promise<string>;
}

const isNativeDocumentAttachment = (fileType?: string, name?: string): boolean => {
  const mime = fileType?.split(';')[0]?.trim().toLowerCase();
  if (mime && (DOCUMENT_MIME_TYPES.has(mime) || mime.startsWith('text/'))) return true;

  const extension = name?.split('.').pop()?.toLowerCase();
  return !!extension && DOCUMENT_EXTENSIONS.has(extension);
};

/**
 * Whether this attachment would be skipped by the native `input_file` path
 * (over the inline size cap, or not a document type the provider accepts).
 */
export const isAttachmentNotDeliveredNatively = (
  file: Pick<SandboxAttachmentToSync, 'fileType' | 'name' | 'size'>,
  nativeFileInput: boolean,
  inlineMaxBytes: number = DEFAULT_FILE_INLINE_MAX_BYTES,
): boolean => {
  if (!nativeFileInput) return true;
  if (!isNativeDocumentAttachment(file.fileType, file.name)) return true;
  return typeof file.size === 'number' && file.size > inlineMaxBytes;
};

export const isSandboxAttachmentSyncEnabled = (enabledToolIds: readonly string[]): boolean =>
  enabledToolIds.includes(CloudSandboxIdentifier);

const dedupeByFileId = <T extends { id: string }>(files: T[]): T[] => {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const file of files) {
    if (!file.id || seen.has(file.id)) continue;
    seen.add(file.id);
    unique.push(file);
  }
  return unique;
};

const hasUsableDownloadUrl = (url: unknown): url is string =>
  typeof url === 'string' && url.trim().length > 0;

const hasSaneAttachmentSize = (size: number | undefined): boolean => {
  if (size == null) return true;
  return Number.isFinite(size) && size >= 0 && size <= SANDBOX_INIT_MAX_FILE_SIZE;
};

/**
 * Collect every user-message attachment on this turn that can be synced into
 * `/mnt/data/uploads`. Native delivery is no longer a reason to skip — the
 * caller decides whether to keep `file_url` alongside `sandboxPath`.
 *
 * `options.nativeFileInput` / `inlineMaxBytes` are accepted for call-site
 * compatibility and are unused; use {@link isAttachmentNotDeliveredNatively}
 * at the caller if you still need the native-vs-sandbox split.
 */
export const selectAttachmentsForSandboxSync = (
  messages: Array<{ fileList?: ChatFileItem[] }>,
  _options?: { nativeFileInput?: boolean; inlineMaxBytes?: number },
): SandboxAttachmentToSync[] => {
  const collected: SandboxAttachmentToSync[] = [];

  for (const message of messages) {
    for (const file of message.fileList ?? []) {
      if (!file?.id || !file.name) continue;
      if (!hasUsableDownloadUrl(file.url)) continue;
      if (!hasSaneAttachmentSize(file.size)) continue;
      collected.push({
        fileType: file.fileType,
        id: file.id,
        name: file.name,
        size: file.size,
        url: file.url,
      });
    }
  }

  return dedupeByFileId(collected);
};

const emptySyncResult = (attemptedFileIds: string[] = []): SyncSandboxAttachmentsResult => ({
  attemptedFileIds,
  sandboxPathByFileId: {},
});

/**
 * Upload attachments into the session sandbox at a collision-free
 * `/mnt/data/uploads/<name>-<id>.<ext>` path. Failures are logged and omitted
 * from `sandboxPathByFileId` so the caller can keep native `file_url` delivery
 * (or the files_info URL) instead of treating the file as synced.
 *
 * URLs are resolved concurrently (bound 3). Downloads are delegated to
 * {@link SyncSandboxAttachmentsDeps.downloadFiles}, which must skip general
 * topic-file initialization.
 */
export const syncSandboxAttachments = async (
  files: SandboxAttachmentToSync[],
  deps: SyncSandboxAttachmentsDeps,
): Promise<SyncSandboxAttachmentsResult> => {
  const unique = dedupeByFileId(files);
  const attemptedFileIds = unique.map((file) => file.id);
  if (unique.length === 0) return emptySyncResult();

  const withStorage = unique.filter((file) => file.url);
  const resolved = await mapWithConcurrency(
    withStorage,
    SANDBOX_ATTACHMENT_SYNC_CONCURRENCY,
    async (file): Promise<SandboxOverLimitAttachment | null> => {
      try {
        const url = deps.resolveDownloadUrl ? await deps.resolveDownloadUrl(file.url) : file.url;
        if (!url) {
          log('Skipping attachment %s: empty download url', file.id);
          return null;
        }
        return { id: file.id, name: file.name, storageKey: file.url, url };
      } catch (error) {
        log('Failed to resolve download url for attachment %s: %O', file.id, error);
        return null;
      }
    },
  );

  const downloads = resolved.filter((item): item is SandboxOverLimitAttachment => item !== null);
  if (downloads.length === 0) return emptySyncResult(attemptedFileIds);

  try {
    const sandboxPathByFileId = await deps.downloadFiles(downloads);
    log(
      'Synced %d/%d attachments into the sandbox',
      Object.keys(sandboxPathByFileId).length,
      unique.length,
    );
    return { attemptedFileIds, sandboxPathByFileId };
  } catch (error) {
    log('Sandbox attachment sync failed: %O', error);
    return emptySyncResult(attemptedFileIds);
  }
};

/**
 * No-op when lobe-cloud-sandbox is not enabled for the run. Never throws.
 */
export const syncOverLimitAttachmentsIfSandboxEnabled = async (params: {
  deps: SyncSandboxAttachmentsDeps;
  enabled: boolean;
  files: SandboxAttachmentToSync[];
}): Promise<SyncSandboxAttachmentsResult> => {
  if (!params.enabled) return emptySyncResult();

  try {
    return await syncSandboxAttachments(params.files, params.deps);
  } catch (error) {
    log('Sandbox attachment sync failed: %O', error);
    return emptySyncResult(params.files.map((file) => file.id));
  }
};
