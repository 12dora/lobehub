import {
  SANDBOX_OVER_LIMIT_UPLOADS_DIR,
  type SandboxCallToolResult,
  type SandboxExportFileResult,
  sandboxOverLimitUploadPath,
  sandboxUploadedFilePath,
  selectSandboxInitFiles,
} from '@lobechat/builtin-tool-cloud-sandbox';
import debug from 'debug';
import { sha256 } from 'js-sha256';

import { getServerDB } from '@/database/core/db-adaptor';
import { FileModel } from '@/database/models/file';

import {
  buildSandboxAttachmentFileSyncCommand,
  buildSandboxFilesInitCommand,
  SANDBOX_ATTACHMENT_SYNC_CONCURRENCY,
  SANDBOX_ATTACHMENT_SYNC_FILE_TIMEOUT_MS,
  SANDBOX_ATTACHMENT_SYNC_OK_PREFIX,
  SANDBOX_FILES_INIT_MARKER,
  SANDBOX_INIT_TIMEOUT_MS,
  sandboxAttachmentSyncMarker,
  type SandboxInitDownload,
} from './bootstrap';
import { recordSandboxPackageInstalls } from './packageLedger';
import { mapWithConcurrency } from './pool';
import type {
  SandboxCommandResult,
  SandboxInterruptResult,
  SandboxOverLimitAttachment,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderKind,
  SandboxPutFile,
  SandboxPutFilesResult,
  SandboxService,
  SandboxServiceOptions,
} from './types';
import { SANDBOX_PUT_FILES_MAX_FILE_BYTES, SANDBOX_PUT_FILES_MAX_TOTAL_BYTES } from './types';

const log = debug('lobe-server:sandbox:service');

const LEDGER_TOOL_NAMES = new Set(['executeCode', 'execScript', 'runCommand']);

export class SandboxMiddlewareService implements SandboxService {
  readonly capabilities: SandboxProviderCapabilities;
  readonly kind: SandboxProviderKind;

  private filesInitialized = false;

  constructor(
    private readonly provider: SandboxProvider,
    private readonly options: SandboxServiceOptions,
  ) {
    this.capabilities = provider.capabilities;
    this.kind = provider.kind;
  }

  async callTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<SandboxCallToolResult> {
    return this.withLocalSession(async () => {
      await this.ensureFilesInitialized();
      if (LEDGER_TOOL_NAMES.has(toolName) && this.options.userId) {
        // Package-install ledger (admin "frequently installed packages"); never throws.
        const db = this.options.serverDB ?? (await getServerDB());
        void recordSandboxPackageInstalls(db, { params, toolName, userId: this.options.userId });
      }
      return this.provider.callTool(toolName, params);
    });
  }

  async interrupt(): Promise<SandboxInterruptResult> {
    return this.withLocalSession(async () => {
      if (typeof this.provider.interrupt !== 'function') return { killed: 0 };
      return this.provider.interrupt({
        topicId: this.options.topicId,
        userId: this.options.userId,
      });
    });
  }

  /**
   * The local Docker provider is constructed as a process-wide singleton (no
   * userId/topicId on the constructor). Bind the current request session for
   * the duration of the provider call so containers stay keyed per topic.
   */
  private async withLocalSession<T>(fn: () => Promise<T>): Promise<T> {
    if (this.kind !== 'local') return fn();

    const { runWithLocalSandboxSession } = await import('./providers/local/sessionContext');
    return runWithLocalSandboxSession(
      { topicId: this.options.topicId, userId: this.options.userId },
      fn,
    );
  }

  /**
   * Sync the files the user uploaded in this topic/session into the sandbox the
   * first time this service instance is used. Best-effort: any failure is
   * swallowed so it never blocks the actual tool call.
   *
   * The downloaded command is guarded by an in-sandbox marker file, which is the
   * single source of truth for idempotency: it is a cheap no-op once synced, and
   * if the sandbox session is recycled the marker disappears so the next call
   * re-syncs automatically. We intentionally do NOT cache the "done" state out of
   * band (e.g. in Redis), because that could skip the re-sync after a recycle and
   * leave the agent believing files exist when /mnt/data is empty.
   */
  private async ensureFilesInitialized(): Promise<void> {
    if (this.filesInitialized) return;
    this.filesInitialized = true;

    const { fileService, serverDB, topicId, userId } = this.options;
    if (!serverDB || !fileService || !topicId || !userId) return;
    if (!this.provider.capabilities.shell) return;

    try {
      const fileModel = new FileModel(serverDB, userId);
      const files = selectSandboxInitFiles(await fileModel.findFilesToInitInSandbox(topicId));

      if (files.length === 0) return;

      const putFiles = this.provider.putFiles?.bind(this.provider);
      if (putFiles) {
        try {
          await this.pushTopicFiles(files, putFiles, fileService, topicId);
          return;
        } catch (error) {
          log(
            'Sandbox file init (push) failed for topic %s, falling back to curl: %O',
            topicId,
            error,
          );
        }
      }

      const downloads = (
        await Promise.all(
          files.map(async (file): Promise<SandboxInitDownload | null> => {
            const url = await fileService
              .createCachedPreSignedUrlForPreview(file.url)
              .catch(() => '');
            return url ? { name: file.name, url } : null;
          }),
        )
      ).filter((item): item is SandboxInitDownload => item !== null);

      if (downloads.length === 0) return;

      const command = buildSandboxFilesInitCommand(downloads);
      const result = await this.provider.callTool('runCommand', {
        command,
        timeout: SANDBOX_INIT_TIMEOUT_MS,
      });

      log(
        'Sandbox file init for topic %s: %d files, success=%s',
        topicId,
        downloads.length,
        result.success,
      );
    } catch (error) {
      log('Sandbox file init failed for topic %s: %O', topicId, error);
    }
  }

  /**
   * Place over-limit attachments at `/mnt/data/uploads` without running
   * {@link ensureFilesInitialized}. Downloads are bounded (3) with a 30s
   * per-file timeout. The download command is never logged (it embeds
   * presigned URLs).
   */
  async syncOverLimitAttachments(
    files: SandboxOverLimitAttachment[],
  ): Promise<Record<string, string>> {
    return this.withLocalSession(async () => {
      const seen = new Set<string>();
      const unique: SandboxOverLimitAttachment[] = [];
      for (const file of files) {
        if (!file.id || !file.url || seen.has(file.id)) continue;
        seen.add(file.id);
        unique.push(file);
      }
      if (unique.length === 0) return {};

      const putFiles = this.provider.putFiles?.bind(this.provider);
      if (putFiles) {
        try {
          return await this.pushOverLimitAttachments(unique, putFiles);
        } catch (error) {
          log('Over-limit attachment push failed, falling back to curl: %O', error);
        }
      }

      const sandboxPathByFileId: Record<string, string> = {};

      await mapWithConcurrency(unique, SANDBOX_ATTACHMENT_SYNC_CONCURRENCY, async (file) => {
        const dest = sandboxOverLimitUploadPath(file.name, file.id);
        try {
          const raw = await this.provider.callTool('runCommand', {
            command: buildSandboxAttachmentFileSyncCommand(file),
            timeout: SANDBOX_ATTACHMENT_SYNC_FILE_TIMEOUT_MS,
          });
          const result = normalizeSandboxCommandResult(raw);
          const output = [result.output, result.stderr].filter(Boolean).join('\n');
          if (`\n${output}\n`.includes(`\n${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}${file.id}\n`)) {
            sandboxPathByFileId[file.id] = dest;
          }
        } catch (error) {
          log('Over-limit attachment %s sync failed: %O', file.id, error);
        }
      });

      log(
        'Over-limit attachment sync finished: %d/%d files',
        Object.keys(sandboxPathByFileId).length,
        unique.length,
      );

      return sandboxPathByFileId;
    });
  }

  /**
   * Push topic-bootstrap files through {@link SandboxProvider.putFiles} and
   * write the same `/mnt/data/.lobe-files-initialized` marker the curl path
   * uses, so a recycled sandbox (marker gone) re-syncs and a live session is
   * a cheap no-op.
   */
  private async pushTopicFiles(
    files: Array<{ name: string; size?: number; url: string }>,
    putFiles: (entries: SandboxPutFile[]) => Promise<SandboxPutFilesResult>,
    fileService: NonNullable<SandboxServiceOptions['fileService']>,
    topicId: string,
  ): Promise<void> {
    const markerCheck = await this.provider.callTool('runCommand', {
      command: `if [ -f ${shellQuote(SANDBOX_FILES_INIT_MARKER)} ]; then echo LOBE_FILES_INIT_DONE; fi`,
      timeout: SANDBOX_INIT_TIMEOUT_MS,
    });
    if (normalizeSandboxCommandResult(markerCheck).output.includes('LOBE_FILES_INIT_DONE')) {
      return;
    }

    const seen = new Set<string>();
    const payload: SandboxPutFile[] = [];
    let failed = 0;
    let totalBytes = 0;

    for (const file of files) {
      if (!file.url) {
        failed += 1;
        continue;
      }
      const path = sandboxUploadedFilePath(file.name);
      if (seen.has(path)) continue;
      seen.add(path);

      if (typeof file.size === 'number' && exceedsPutFilesCaps(file.size, totalBytes)) {
        failed += 1;
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = await fileService.getFileByteArray(file.url);
      } catch (error) {
        log('Sandbox file init (push) failed to read %s: %O', file.url, error);
        failed += 1;
        continue;
      }

      if (exceedsPutFilesCaps(bytes.byteLength, totalBytes)) {
        failed += 1;
        continue;
      }

      totalBytes += bytes.byteLength;
      payload.push({ bytes, path });
    }

    // Match curl: the marker is always written once a sync is attempted, even
    // if some (or all) downloads failed, so we do not retry every tool call.
    payload.push({ bytes: new Uint8Array(0), path: SANDBOX_FILES_INIT_MARKER });

    const result = await putFiles(payload);
    failed += result.failed.filter((item) => item.path !== SANDBOX_FILES_INIT_MARKER).length;

    log(
      'Sandbox file init (push) for topic %s: %d files, %d failed',
      topicId,
      files.length,
      failed,
    );
  }

  private async pushOverLimitAttachments(
    unique: SandboxOverLimitAttachment[],
    putFiles: (entries: SandboxPutFile[]) => Promise<SandboxPutFilesResult>,
  ): Promise<Record<string, string>> {
    const fileService = this.options.fileService;
    if (!fileService) {
      throw new Error('fileService is required for sandbox file push');
    }

    const sandboxPathByFileId = await this.readAttachmentSyncMarkers(unique);
    const pending = unique.filter((file) => !sandboxPathByFileId[file.id]);
    if (pending.length === 0) return sandboxPathByFileId;

    const payload: SandboxPutFile[] = [];
    const destById = new Map<string, string>();
    let totalBytes = 0;

    for (const file of pending) {
      const dest = sandboxOverLimitUploadPath(file.name, file.id);
      const key = resolveAttachmentStorageKey(file);
      if (!key) continue;

      if (typeof file.size === 'number' && exceedsPutFilesCaps(file.size, totalBytes)) {
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = await fileService.getFileByteArray(key);
      } catch (error) {
        log('Over-limit attachment %s read failed: %O', file.id, error);
        continue;
      }

      if (exceedsPutFilesCaps(bytes.byteLength, totalBytes)) {
        continue;
      }

      totalBytes += bytes.byteLength;
      destById.set(file.id, dest);
      payload.push({ bytes, path: dest });
      payload.push({ bytes: new Uint8Array(0), path: sandboxAttachmentSyncMarker(file.id) });
    }

    if (payload.length > 0) {
      const result = await putFiles(payload);
      const written = new Set(result.written);
      for (const [id, dest] of destById) {
        if (written.has(dest)) sandboxPathByFileId[id] = dest;
      }
    }

    log(
      'Over-limit attachment sync (push) finished: %d/%d files',
      Object.keys(sandboxPathByFileId).length,
      unique.length,
    );

    return sandboxPathByFileId;
  }

  private async readAttachmentSyncMarkers(
    files: SandboxOverLimitAttachment[],
  ): Promise<Record<string, string>> {
    const checks = files.map((file) => {
      const dest = sandboxOverLimitUploadPath(file.name, file.id);
      const marker = sandboxAttachmentSyncMarker(file.id);
      const echoedId = file.id.replaceAll(/[\n\r]/g, '');
      return `if [ -f ${shellQuote(marker)} ] && [ -f ${shellQuote(dest)} ]; then echo ${shellQuote(`${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}${echoedId}`)}; fi`;
    });
    const raw = await this.provider.callTool('runCommand', {
      command: [`mkdir -p ${shellQuote(SANDBOX_OVER_LIMIT_UPLOADS_DIR)}`, ...checks].join('; '),
      timeout: SANDBOX_ATTACHMENT_SYNC_FILE_TIMEOUT_MS,
    });
    const result = normalizeSandboxCommandResult(raw);
    const output = [result.output, result.stderr].filter(Boolean).join('\n');
    const found: Record<string, string> = {};
    for (const file of files) {
      if (`\n${output}\n`.includes(`\n${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}${file.id}\n`)) {
        found[file.id] = sandboxOverLimitUploadPath(file.name, file.id);
      }
    }
    return found;
  }

  async exportAndUploadFile(path: string, filename: string): Promise<SandboxExportFileResult> {
    const { fileService, topicId } = this.options;

    if (!fileService) {
      return {
        error: { message: 'fileService is required for sandbox file export' },
        filename,
        success: false,
      };
    }

    log('Exporting file: %s from path: %s, topicId: %s', filename, path, topicId);

    try {
      const now = Date.now();
      const today = new Date(now).toISOString().split('T')[0];
      const key = `code-interpreter-exports/${today}/${topicId}/${filename}`;
      const upload = await fileService.createPreSignedUpload(key);

      const exported = await this.withLocalSession(() =>
        this.provider.exportFileToUploadUrl({
          filename,
          path,
          uploadHeaders: upload.headers,
          uploadUrl: upload.url,
        }),
      );

      if (!exported.success) {
        return {
          error: {
            message: exported.error?.message || 'Failed to export file from sandbox',
            name: exported.error?.name,
          },
          filename,
          success: false,
        };
      }

      const metadata = await fileService.getFileMetadata(key);
      const fileSize = metadata.contentLength;
      const mimeType =
        metadata.contentType ||
        exported.mimeType ||
        String(exported.result?.mimeType || '') ||
        String(exported.result?.mime_type || '') ||
        'application/octet-stream';
      const fileHash = sha256(key + now.toString());

      const { fileId, url } = await fileService.createFileRecord({
        fileHash,
        fileType: mimeType,
        name: filename,
        size: fileSize,
        url: key,
      });

      return {
        fileId,
        filename,
        mimeType,
        size: fileSize,
        success: true,
        url,
      };
    } catch (error) {
      log('Error exporting file: %O', error);

      return {
        error: { message: (error as Error).message },
        filename,
        success: false,
      };
    }
  }
}

export const isInterruptedSandboxResult = (result: SandboxCallToolResult): boolean =>
  result.result?.interrupted === true;

export const normalizeSandboxCommandResult = (
  result: SandboxCallToolResult,
): SandboxCommandResult => {
  const interrupted = isInterruptedSandboxResult(result);

  if (!result.success && !interrupted) {
    return {
      exitCode: 1,
      output: '',
      stderr: result.error?.message || 'Command execution failed',
      success: false,
    };
  }

  const raw = result.result || {};
  const rawExitCode = raw.exitCode ?? raw.exit_code;
  const exitCode = typeof rawExitCode === 'number' ? rawExitCode : interrupted ? 143 : 0;
  const output = String(raw.stdout || raw.output || '');
  const stderr = raw.stderr === undefined ? undefined : String(raw.stderr);
  const success = typeof raw.success === 'boolean' ? raw.success : !interrupted && exitCode === 0;

  return {
    exitCode,
    ...(interrupted ? { interrupted: true } : {}),
    output,
    stderr,
    success,
  };
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

const exceedsPutFilesCaps = (size: number, totalBytes: number): boolean =>
  size > SANDBOX_PUT_FILES_MAX_FILE_BYTES || totalBytes + size > SANDBOX_PUT_FILES_MAX_TOTAL_BYTES;

const resolveAttachmentStorageKey = (file: SandboxOverLimitAttachment): string | undefined => {
  if (file.storageKey && !isHttpUrl(file.storageKey)) return file.storageKey;
  if (file.url && !isHttpUrl(file.url)) return file.url;
  return undefined;
};

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);
