import { CloudSandboxIdentifier } from '@lobechat/builtin-tool-cloud-sandbox';
import type { ChatFileItem } from '@lobechat/types';
import { DEFAULT_FILE_INLINE_MAX_BYTES } from '@lobechat/utils';
import debug from 'debug';

import type { SandboxAttachmentUpload } from './bootstrap';
import { SANDBOX_ATTACHMENT_SYNC_CONCURRENCY } from './bootstrap';
import { mapWithConcurrency } from './pool';

const log = debug('lobe-server:sandbox:attachmentSync');

/**
 * Document types the Responses `input_file` path can inline. Mirrors the
 * runtime check in `packages/model-runtime/src/core/contextBuilders/openai.ts`
 * so we only sync files that would not be delivered natively.
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
   * already-presigned URLs.
   */
  downloadFiles: (files: SandboxAttachmentUpload[]) => Promise<Record<string, string>>;
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

/**
 * Collect user-message attachments that were not delivered natively and should
 * be synced into `/mnt/data/uploads` when the sandbox is the execution target.
 */
export const selectAttachmentsForSandboxSync = (
  messages: Array<{ fileList?: ChatFileItem[] }>,
  options: { nativeFileInput: boolean; inlineMaxBytes?: number },
): SandboxAttachmentToSync[] => {
  const collected: SandboxAttachmentToSync[] = [];

  for (const message of messages) {
    for (const file of message.fileList ?? []) {
      if (!file?.id || !file.name) continue;
      if (
        !isAttachmentNotDeliveredNatively(file, options.nativeFileInput, options.inlineMaxBytes)
      ) {
        continue;
      }
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
 * Upload non-native attachments into the session sandbox at a collision-free
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
    async (file): Promise<SandboxAttachmentUpload | null> => {
      try {
        const url = deps.resolveDownloadUrl ? await deps.resolveDownloadUrl(file.url) : file.url;
        if (!url) {
          log('Skipping attachment %s: empty download url', file.id);
          return null;
        }
        return { id: file.id, name: file.name, url };
      } catch (error) {
        log('Failed to resolve download url for attachment %s: %O', file.id, error);
        return null;
      }
    },
  );

  const downloads = resolved.filter((item): item is SandboxAttachmentUpload => item !== null);
  if (downloads.length === 0) return emptySyncResult(attemptedFileIds);

  try {
    const sandboxPathByFileId = await deps.downloadFiles(downloads);
    log(
      'Synced %d/%d over-limit attachments into the sandbox',
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
