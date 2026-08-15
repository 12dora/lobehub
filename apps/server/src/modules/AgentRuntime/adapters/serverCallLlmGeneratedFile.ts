import { createHash } from 'node:crypto';

import type { StreamChunkFile } from '@lobechat/agent-gateway-client';
import type { StreamFileData } from '@lobechat/model-runtime';

import { fileEnv } from '@/envs/file';
import { FileService } from '@/server/services/file';
import { nanoid } from '@/utils/uuid';

import type { RuntimeExecutorContext } from '../context';
import { isOperationInterrupted, log } from '../executorHelpers';

/**
 * Hard cap on a single generated file. The bytes travel base64-encoded inside
 * one SSE frame (~1.37x) and are held as one JS string before decoding, so an
 * unbounded file would blow up the server's heap. Anything larger is dropped
 * with a log line — the answer itself is never failed for it.
 */
export const MAX_GENERATED_FILE_BYTES = 32 * 1024 * 1024;

const MAX_FILE_NAME_LENGTH = 128;

const DATA_URI_PATTERN = /^data:([^,;]*)(?:;[^,]*)?,(.*)$/s;

interface ParsedDataUri {
  base64: string;
  mimeType?: string;
}

/** Split `data:<mime>;base64,<payload>` — returns undefined when not a base64 data URI. */
export const parseBase64DataUri = (value: string): ParsedDataUri | undefined => {
  const match = DATA_URI_PATTERN.exec(value);
  if (!match) return undefined;
  // Only base64 payloads are supported; a percent-encoded data URI has no
  // `;base64` marker and would decode to garbage through Buffer.from(…, 'base64').
  if (!/;base64/i.test(value.slice(0, value.indexOf(',')))) return undefined;

  const base64 = match[2].trim();
  if (!base64) return undefined;

  return { base64, mimeType: match[1] || undefined };
};

/**
 * Make a model-supplied file name safe to use as the last path segment of an
 * object key (and as the displayed name), while keeping the extension so the
 * file opens with the right app after download.
 */
export const sanitizeGeneratedFileName = (raw: string | undefined): string => {
  const base = (raw ?? '').split(/[/\\]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u001F\u007F]/g, '')
    .replaceAll(/["*:<>?|]/g, '_')
    // leading dots would create a hidden / relative-looking name
    .replace(/^\.+/, '')
    .trim();

  if (!cleaned) return `generated-file-${nanoid()}`;
  if (cleaned.length <= MAX_FILE_NAME_LENGTH) return cleaned;

  const dotIndex = cleaned.lastIndexOf('.');
  const ext = dotIndex > 0 && cleaned.length - dotIndex <= 17 ? cleaned.slice(dotIndex) : '';
  return cleaned.slice(0, MAX_FILE_NAME_LENGTH - ext.length) + ext;
};

export interface GeneratedFileUploader {
  /**
   * How many files have been attached to the assistant message so far. A turn
   * whose only output is a generated file is NOT an empty completion, so the
   * executor's empty-completion guard reads this counter.
   */
  attachedFileCount: () => number;
  /**
   * Stop attaching/publishing anything that is still in flight, then settle.
   * Called from the attempt's `finally` so a retried or interrupted attempt can
   * never attach a file to — or publish a `file` chunk after — a turn that has
   * already produced its terminal event. Never rejects.
   */
  cancel: () => Promise<void>;
  /**
   * Handle one `file` stream chunk. Fire-and-forget: the upload runs in the
   * background and is tracked by {@link waitForUploads}.
   */
  handleFile: (file: StreamFileData) => void;
  /** Settle every in-flight upload. Never rejects. */
  waitForUploads: () => Promise<void>;
}

/**
 * Operation-scoped record of the generated files that already made it onto the
 * assistant message. It outlives a single attempt on purpose: retries share the
 * assistant message id, and every `uploadFromBuffer` mints a fresh file UUID, so
 * without this a re-generated identical export would land as a second
 * `messages_files` row and a duplicate card.
 */
export interface GeneratedFileDedupeStore {
  /** Reserve a file key; `false` when the same file was already handled. */
  claim: (key: string) => boolean;
  /** Give a reserved key back after a failed delivery so a retry may redo it. */
  release: (key: string) => void;
}

export const createGeneratedFileDedupeStore = (): GeneratedFileDedupeStore => {
  const seen = new Set<string>();
  return {
    claim: (key) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    release: (key) => {
      seen.delete(key);
    },
  };
};

interface CreateGeneratedFileUploaderInput {
  /** The message the executor is streaming into — the attach target. */
  assistantMessageId: string;
  ctx: RuntimeExecutorContext;
  /** Shared across the retry attempts of one `call_llm`. */
  dedupe?: GeneratedFileDedupeStore;
  operationLogId: string;
}

/**
 * Exact decoded size of a base64 payload — `length * 3 / 4` minus the padding.
 * Ignoring padding overshoots by up to 2 bytes, which rejects a file of exactly
 * {@link MAX_GENERATED_FILE_BYTES}.
 */
export const decodedBase64Length = (base64: string): number => {
  let padding = 0;
  for (let i = base64.length - 1; i >= 0 && base64[i] === '=' && padding < 2; i--) padding++;
  return Math.floor((base64.length * 3) / 4) - padding;
};

/**
 * Gateway-mode counterpart of the client `StreamingHandler` file path: decode
 * the generated file, store it in the run owner's file storage, attach it to
 * the assistant message (`messages_files`, the source of truth a later message
 * reload hydrates `fileList` from) and publish a `file` stream chunk carrying
 * ONLY the persisted metadata — never the base64 — so the client can show the
 * card immediately.
 *
 * Every failure is swallowed: a missing export must never fail the answer.
 */
export const createGeneratedFileUploader = ({
  assistantMessageId,
  ctx,
  dedupe = createGeneratedFileDedupeStore(),
  operationLogId,
}: CreateGeneratedFileUploaderInput): GeneratedFileUploader => {
  const uploads: Promise<void>[] = [];
  const datePrefix = new Date().toISOString().split('T')[0];
  let cancelled = false;
  let attachedCount = 0;

  /**
   * Drop the user-visible `files` row for a file we could not deliver (attach
   * failed, or the run was cancelled between upload and attach). Only the user
   * record goes: the `globalFiles` row + S3 object are content-addressed and may
   * be shared with another file, so deleting them could break an unrelated one.
   */
  const discardOrphanFile = async (fileId: string): Promise<void> => {
    if (!ctx.userId) return;
    try {
      const fileService = new FileService(ctx.serverDB, ctx.userId, ctx.workspaceId);
      await fileService.deleteUserFileRecord(fileId);
    } catch (error) {
      log('[%s][file] orphan cleanup failed fileId=%s error=%O', operationLogId, fileId, error);
    }
  };

  const process = async (file: StreamFileData): Promise<void> => {
    if (cancelled) return;

    if (!ctx.userId) {
      log('[%s][file] no userId on the run context, dropping %s', operationLogId, file?.name);
      return;
    }

    const parsed = file?.data ? parseBase64DataUri(file.data) : undefined;
    if (!parsed) {
      log('[%s][file] chunk carries no base64 data URI, dropping %s', operationLogId, file?.name);
      return;
    }

    // Bound BEFORE decoding — 4 base64 chars carry 3 bytes, minus padding.
    const approxBytes = decodedBase64Length(parsed.base64);
    if (approxBytes > MAX_GENERATED_FILE_BYTES) {
      log(
        '[%s][file] %s is too large (~%d bytes > %d), dropping',
        operationLogId,
        file.name,
        approxBytes,
        MAX_GENERATED_FILE_BYTES,
      );
      return;
    }

    const buffer = Buffer.from(parsed.base64, 'base64');
    if (buffer.length === 0 || buffer.length > MAX_GENERATED_FILE_BYTES) {
      log('[%s][file] %s decoded to %d bytes, dropping', operationLogId, file.name, buffer.length);
      return;
    }

    const mimeType = file.mimeType || parsed.mimeType || 'application/octet-stream';
    const name = sanitizeGeneratedFileName(file.name);

    // Operation-scoped identity: the same export re-emitted by a retried attempt
    // (or redelivered inside one attempt) must attach exactly once. Content hash
    // rather than the model-declared `size`, which the provider may omit or lie
    // about.
    const dedupeKey = `${assistantMessageId}:${name}:${buffer.length}:${createHash('sha256')
      .update(buffer)
      .digest('hex')}`;
    if (!dedupe.claim(dedupeKey)) {
      log(
        '[%s][file] %s already attached to %s, skipping',
        operationLogId,
        name,
        assistantMessageId,
      );
      return;
    }

    // nanoid directory (not a name prefix) so the stored file keeps the exact
    // name the model gave it — `uploadFromBuffer` derives the record name from
    // the last path segment.
    const pathname = `${fileEnv.NEXT_PUBLIC_S3_FILE_PATH}/generations/${datePrefix}/${nanoid()}/${name}`;

    if (cancelled) {
      dedupe.release(dedupeKey);
      return;
    }

    let uploaded: { fileId: string; url: string };
    try {
      const fileService = new FileService(ctx.serverDB, ctx.userId, ctx.workspaceId);
      uploaded = await fileService.uploadFromBuffer(buffer, mimeType, pathname);
    } catch (error) {
      // Nothing landed — let a retried attempt upload this file again.
      dedupe.release(dedupeKey);
      log('[%s][file] upload failed name=%s error=%O', operationLogId, name, error);
      return;
    }

    // The run reached its terminal event while this upload was in flight (retry
    // or user cancel): never attach to — or publish onto — a finished turn.
    // `cancelled` is set by the attempt's `finally`; the interrupt probe closes
    // the window where the upload settles while the executor is still unwinding.
    if (cancelled || (await isOperationInterrupted(ctx))) {
      dedupe.release(dedupeKey);
      log('[%s][file] run ended mid-upload, discarding %s', operationLogId, uploaded.fileId);
      await discardOrphanFile(uploaded.fileId);
      return;
    }

    let attached = false;
    let attachFailure: unknown;
    try {
      // `addFiles` resolves `{ success: false }` instead of throwing on a DB
      // error, so a resolved promise is not proof the row landed.
      const result = await ctx.messageModel.addFiles(assistantMessageId, [uploaded.fileId]);
      attached = !!result?.success;
      if (!attached) attachFailure = result;
    } catch (error) {
      attachFailure = error;
    }

    // A `file` chunk states that the file is already attached and persisted, so
    // publishing an unattached one paints a card that vanishes on the next DB
    // reconciliation. Drop the orphan user file record instead and let the
    // answer stand — a missing export must never fail the turn.
    if (!attached) {
      dedupe.release(dedupeKey);
      log(
        '[%s][file] attach failed messageId=%s fileId=%s reason=%O — not publishing',
        operationLogId,
        assistantMessageId,
        uploaded.fileId,
        attachFailure,
      );
      await discardOrphanFile(uploaded.fileId);
      return;
    }

    // Attached: the file is real output of this turn even if the live card never
    // makes it to the client (it rehydrates from `messages_files` on reload).
    attachedCount++;

    if (cancelled) return;

    const payload: StreamChunkFile = {
      fileType: mimeType,
      id: uploaded.fileId,
      name,
      size: buffer.length,
      url: uploaded.url,
    };

    try {
      await ctx.streamManager.publishStreamChunk(ctx.operationId, ctx.stepIndex, {
        chunkType: 'file',
        file: payload,
      });
    } catch (error) {
      log('[%s][file] publish failed fileId=%s error=%O', operationLogId, uploaded.fileId, error);
    }
  };

  // Loops because a late `file` chunk can be pushed while we're awaiting the
  // earlier ones — `Promise.allSettled` snapshots the array at call time.
  const settle = async () => {
    let settled = 0;
    while (uploads.length > settled) {
      settled = uploads.length;
      await Promise.allSettled(uploads.slice(0, settled));
    }
  };

  return {
    attachedFileCount: () => attachedCount,
    cancel: async () => {
      cancelled = true;
      await settle();
    },
    handleFile: (file) => {
      if (cancelled) return;
      uploads.push(process(file));
    },
    waitForUploads: settle,
  };
};
