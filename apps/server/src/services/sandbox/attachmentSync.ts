import type { ISandboxService } from '@lobechat/builtin-tool-cloud-sandbox';
import {
  CloudSandboxIdentifier,
  sandboxOverLimitUploadPath,
} from '@lobechat/builtin-tool-cloud-sandbox';
import type { ChatFileItem } from '@lobechat/types';
import { DEFAULT_FILE_INLINE_MAX_BYTES } from '@lobechat/utils';
import debug from 'debug';

import {
  buildSandboxAttachmentUploadCommand,
  SANDBOX_ATTACHMENT_SYNC_OK_PREFIX,
  SANDBOX_INIT_TIMEOUT_MS,
  type SandboxAttachmentUpload,
} from './bootstrap';
import { normalizeSandboxCommandResult } from './service';

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

export interface SyncSandboxAttachmentsDeps {
  callTool: ISandboxService['callTool'];
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

const parseSyncedFileIds = (output: string, fileIds: readonly string[]): Set<string> => {
  const haystack = `\n${output}\n`;
  const synced = new Set<string>();
  for (const id of fileIds) {
    if (haystack.includes(`\n${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}${id}\n`)) {
      synced.add(id);
    }
  }
  return synced;
};

/**
 * Upload non-native attachments into the session sandbox at
 * `/mnt/data/uploads/<filename>`. Idempotent per file id within a call
 * (and across the session via in-sandbox markers). Failures are logged and
 * omitted from the result so the turn can fall back to text-only files_info.
 */
export const syncSandboxAttachments = async (
  files: SandboxAttachmentToSync[],
  deps: SyncSandboxAttachmentsDeps,
): Promise<Record<string, string>> => {
  const unique = dedupeByFileId(files).filter((file) => file.url);
  if (unique.length === 0) return {};

  const downloads: SandboxAttachmentUpload[] = [];

  for (const file of unique) {
    try {
      const url = deps.resolveDownloadUrl ? await deps.resolveDownloadUrl(file.url) : file.url;
      if (!url) {
        log('Skipping attachment %s: empty download url', file.id);
        continue;
      }
      downloads.push({ id: file.id, name: file.name, url });
    } catch (error) {
      log('Failed to resolve download url for attachment %s: %O', file.id, error);
    }
  }

  if (downloads.length === 0) return {};

  const command = buildSandboxAttachmentUploadCommand(downloads);

  try {
    const raw = await deps.callTool('runCommand', {
      command,
      timeout: SANDBOX_INIT_TIMEOUT_MS,
    });
    const result = normalizeSandboxCommandResult(raw);
    const output = [result.output, result.stderr].filter(Boolean).join('\n');
    const syncedIds = parseSyncedFileIds(
      output,
      downloads.map((file) => file.id),
    );

    const sandboxPathByFileId: Record<string, string> = {};
    for (const file of unique) {
      if (!syncedIds.has(file.id)) continue;
      sandboxPathByFileId[file.id] = sandboxOverLimitUploadPath(file.name);
    }

    log(
      'Synced %d/%d over-limit attachments into the sandbox',
      Object.keys(sandboxPathByFileId).length,
      unique.length,
    );

    return sandboxPathByFileId;
  } catch (error) {
    log('Sandbox attachment sync failed: %O', error);
    return {};
  }
};

/**
 * No-op when lobe-cloud-sandbox is not enabled for the run. Never throws.
 */
export const syncOverLimitAttachmentsIfSandboxEnabled = async (params: {
  enabled: boolean;
  files: SandboxAttachmentToSync[];
  deps: SyncSandboxAttachmentsDeps;
}): Promise<Record<string, string>> => {
  if (!params.enabled) return {};

  try {
    return await syncSandboxAttachments(params.files, params.deps);
  } catch (error) {
    log('Sandbox attachment sync failed: %O', error);
    return {};
  }
};
