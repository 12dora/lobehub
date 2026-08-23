import type { FileRenderMetadata, FileRenderTextIndex } from '@lobechat/types';
import { readFileRenderMetadata } from '@lobechat/types';
import type { OwnDeploymentOrigins } from '@lobechat/utils';
import { resolveMimeTypeFromBytes, sanitizedUrlHost } from '@lobechat/utils';
import debug from 'debug';

import { getServerDB } from '@/database/core/db-adaptor';
import { FileModel } from '@/database/models/file';
import type { LobeChatDatabase } from '@/database/type';
import { FileService } from '@/server/services/file';

import { isArtifactKeyForFile } from './attachmentInlinerPdf';
import type {
  CreateOwnOriginAttachmentInlineHooksInput,
  OwnOriginAttachmentBytes,
  OwnOriginAttachmentResolver,
  OwnOriginFileIdResolver,
} from './attachmentInlinerTypes';
import { extractFileProxyId, isResolvableAppFileUrl } from './attachmentInlinerUrls';
import { bumpDocumentFeedStat } from './documentFeedStats';

const log = debug('lobe-server:attachment-inliner');
const RENDER_WAIT_BUDGET_MS = 10_000;
const RENDER_WAIT_POLL_MS = 1000;
const RENDER_WAIT_MAX_AGE_MS = 120_000;

/** Pending renders younger than two minutes are worth a short wait; older ones are stuck. */
const isFreshPendingRender = (render: FileRenderMetadata | undefined): boolean => {
  if (!render || render.status !== 'pending') return false;
  const updatedAt = render.updatedAt ? Date.parse(render.updatedAt) : Number.NaN;
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < RENDER_WAIT_MAX_AGE_MS;
};

const resolveMaybeLazy = async <T>(value: T | Promise<T> | (() => T | Promise<T>)): Promise<T> =>
  typeof value === 'function' ? (value as () => T | Promise<T>)() : value;

interface LoadedFileServices {
  db: LobeChatDatabase;
  fileModel?: FileModel;
  fileService: FileService;
}

class FileServiceResolvers {
  private readonly authorizedFileIds = new Set<string>();
  private readonly byFileId = new Map<string, Promise<OwnOriginAttachmentBytes | null>>();
  private readonly fileLookup = new Map<
    string,
    Promise<Awaited<ReturnType<FileModel['findById']>>>
  >();
  private loaded?: Promise<LoadedFileServices>;
  private renderWaitDeadline?: number;

  constructor(
    private readonly input: CreateOwnOriginAttachmentInlineHooksInput,
    private readonly origins: OwnDeploymentOrigins,
  ) {}

  private load(): Promise<LoadedFileServices> {
    this.loaded ??= (async () => {
      const db = await resolveMaybeLazy(this.input.db ?? getServerDB);
      return {
        db,
        fileModel: this.input.userId ? new FileModel(db, this.input.userId) : undefined,
        fileService: new FileService(db, this.input.userId ?? ''),
      };
    })();
    return this.loaded;
  }

  private async lookupFile(fileId: string) {
    const existing = this.fileLookup.get(fileId);
    if (existing) return existing;
    const pending = (async () => {
      const { db, fileModel } = await this.load();
      if (fileModel) return fileModel.findById(fileId);
      log('unscoped file lookup id=%s (no userId; internal caller)', fileId);
      return FileModel.getFileById(db, fileId);
    })();
    this.fileLookup.set(fileId, pending);
    const file = await pending;
    if (file) this.authorizedFileIds.add(fileId);
    return file;
  }

  async authorizeFile(fileId: string): Promise<boolean> {
    if (this.authorizedFileIds.has(fileId)) return true;
    return Boolean(await this.lookupFile(fileId));
  }

  async resolveByFileId(fileId: string, maxBytes: number) {
    const memoKey = `${fileId}:${maxBytes}`;
    const existing = this.byFileId.get(memoKey);
    if (existing) return existing;
    const pending = this.loadFileBytes(fileId, maxBytes);
    this.byFileId.set(memoKey, pending);
    return pending;
  }

  private async loadFileBytes(
    fileId: string,
    maxBytes: number,
  ): Promise<OwnOriginAttachmentBytes | null> {
    try {
      const { fileService } = await this.load();
      const file = await this.lookupFile(fileId);
      if (!file) {
        log('file not found id=%s', fileId);
        return null;
      }
      // Check the files-row size before reading so over-cap objects never enter memory.
      if (typeof file.size === 'number' && file.size > maxBytes) {
        log('skip over-cap file id=%s size=%d max=%d', fileId, file.size, maxBytes);
        return null;
      }
      const bytes = await fileService.getFileByteArray(file.url);
      if (!bytes?.byteLength) {
        log('empty attachment bytes id=%s', fileId);
        return null;
      }
      if (bytes.byteLength > maxBytes) {
        log('skip over-cap attachment id=%s size=%d max=%d', fileId, bytes.byteLength, maxBytes);
        return null;
      }
      const mimeType = await resolveMimeTypeFromBytes(file.fileType, bytes);
      return { bytes, mimeType };
    } catch (error) {
      log(
        'failed to resolve attachment id=%s error=%s',
        fileId,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  async resolveByUrl(url: string, maxBytes: number) {
    if (!isResolvableAppFileUrl(url, this.origins)) {
      log('skip non-app-file attachment host=%s', sanitizedUrlHost(url));
      return null;
    }
    const fileId = extractFileProxyId(url);
    if (!fileId) return null;
    return this.resolveByFileId(fileId, maxBytes);
  }

  // One wait budget per request: a render enqueued by the upload seconds ago
  // usually finishes within a few seconds, so the first turn can still use it.
  async loadRender(fileId: string): Promise<FileRenderMetadata | undefined> {
    try {
      const file = await this.lookupFile(fileId);
      let render = readFileRenderMetadata(file?.metadata);
      if (!file || !isFreshPendingRender(render)) return render;
      bumpDocumentFeedStat('pendingWaits');
      const { fileModel, db } = await this.load();
      this.renderWaitDeadline ??= Date.now() + RENDER_WAIT_BUDGET_MS;
      while (render && render.status === 'pending' && Date.now() < this.renderWaitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, RENDER_WAIT_POLL_MS));
        const current = fileModel
          ? await fileModel.findById(fileId)
          : await FileModel.getFileById(db, fileId);
        render = readFileRenderMetadata(current?.metadata) ?? render;
      }
      return render;
    } catch (error) {
      log(
        'failed to load render metadata id=%s error=%s',
        fileId,
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
  }

  async loadTextIndex(fileId: string, key: string): Promise<FileRenderTextIndex | undefined> {
    try {
      if (!isArtifactKeyForFile(key, fileId)) {
        log('skip text-index artifact outside prefix fileId=%s key=%s', fileId, key);
        return undefined;
      }
      if (!(await this.authorizeFile(fileId))) return undefined;
      const { fileService } = await this.load();
      const raw = await fileService.getFileContent(key);
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      return parsed as FileRenderTextIndex;
    } catch (error) {
      log(
        'failed to load text index fileId=%s key=%s error=%s',
        fileId,
        key,
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
  }

  async loadArtifact(key: string, fileId: string): Promise<Uint8Array | null> {
    try {
      if (!(await this.authorizeFile(fileId))) return null;
      if (!this.authorizedFileIds.has(fileId) || !isArtifactKeyForFile(key, fileId)) {
        log('skip artifact outside allow-set or prefix fileId=%s key=%s', fileId, key);
        return null;
      }
      const { fileService } = await this.load();
      const bytes = await fileService.getFileByteArray(key);
      if (!bytes?.byteLength) return null;
      return bytes;
    } catch (error) {
      log(
        'failed to load render artifact key=%s error=%s',
        key,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }
}

export const createFileServiceResolvers = (
  input: CreateOwnOriginAttachmentInlineHooksInput,
  origins: OwnDeploymentOrigins,
): {
  authorizeFile: (fileId: string) => Promise<boolean>;
  loadArtifact: (key: string, fileId: string) => Promise<Uint8Array | null>;
  loadRender: (fileId: string) => Promise<FileRenderMetadata | undefined>;
  loadTextIndex: (fileId: string, key: string) => Promise<FileRenderTextIndex | undefined>;
  resolveByFileId: OwnOriginFileIdResolver;
  resolveByUrl: OwnOriginAttachmentResolver;
} => {
  const resolvers = new FileServiceResolvers(input, origins);
  return {
    authorizeFile: (fileId) => resolvers.authorizeFile(fileId),
    loadArtifact: (key, fileId) => resolvers.loadArtifact(key, fileId),
    loadRender: (fileId) => resolvers.loadRender(fileId),
    loadTextIndex: (fileId, key) => resolvers.loadTextIndex(fileId, key),
    resolveByFileId: (fileId, maxBytes) => resolvers.resolveByFileId(fileId, maxBytes),
    resolveByUrl: (url, maxBytes) => resolvers.resolveByUrl(url, maxBytes),
  };
};
