import type {
  ModelRuntimeHooks,
  OpenAIChatMessage,
  UserMessageContentPart,
} from '@lobechat/model-runtime';
import { isFileUrlPart } from '@lobechat/model-runtime';
import type { OwnDeploymentOrigins } from '@lobechat/utils';
import {
  isOwnDeploymentFileUrl,
  resolveMimeTypeFromBytes,
  sanitizedUrlHost,
} from '@lobechat/utils';
import {
  DEFAULT_FILE_INLINE_MAX_BYTES,
  DEFAULT_IMAGE_INLINE_MAX_BYTES,
} from '@lobechat/utils/imageToBase64';
import debug from 'debug';

import { getServerDB } from '@/database/core/db-adaptor';
import { FileModel } from '@/database/models/file';
import type { LobeChatDatabase } from '@/database/type';
import { FileService } from '@/server/services/file';

const log = debug('lobe-server:attachment-inliner');

const INLINE_RESOLVE_CONCURRENCY = 4;
const FILE_PROXY_PATH = /^\/f\/([^/]+)$/;

export interface OwnOriginAttachmentBytes {
  bytes: Uint8Array;
  mimeType: string;
}

export type OwnOriginAttachmentResolver = (url: string) => Promise<OwnOriginAttachmentBytes | null>;

type MaybeLazy<T> = T | Promise<T> | (() => T | Promise<T>);

export interface CreateOwnOriginAttachmentInlineHooksInput {
  db?: MaybeLazy<LobeChatDatabase>;
  ownOrigins: MaybeLazy<OwnDeploymentOrigins>;
  userId?: string;
}

const resolveMaybeLazy = async <T>(value: MaybeLazy<T>): Promise<T> =>
  typeof value === 'function' ? (value as () => T | Promise<T>)() : value;

const isImageUrlPart = (
  part: UserMessageContentPart,
): part is Extract<UserMessageContentPart, { type: 'image_url' }> =>
  part.type === 'image_url' && typeof part.image_url?.url === 'string';

const isDataUri = (url: string): boolean => url.startsWith('data:');

const toDataUri = (mimeType: string, bytes: Uint8Array): string =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;

const extractFileProxyId = (url: string): string | undefined => {
  try {
    const match = FILE_PROXY_PATH.exec(new URL(url).pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
};

const stripOwnOriginUrlAttributes = (text: string, origins: OwnDeploymentOrigins): string =>
  text.replaceAll(/ url="([^"]+)"/g, (matched, url: string) =>
    isOwnDeploymentFileUrl(url, origins) ? '' : matched,
  );

const hasUserAttachmentCandidates = (messages: OpenAIChatMessage[]): boolean => {
  for (const message of messages) {
    if (message.role !== 'user') continue;

    const { content } = message;
    if (typeof content === 'string') {
      if (content.includes(' url="')) return true;
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (part.type === 'text' && part.text.includes(' url="')) return true;
      if (isImageUrlPart(part) && part.image_url.url && !isDataUri(part.image_url.url)) return true;
      if (isFileUrlPart(part) && !isDataUri(part.file_url.url)) return true;
    }
  }

  return false;
};

const collectOwnOriginAttachmentUrls = (
  messages: OpenAIChatMessage[],
  origins: OwnDeploymentOrigins,
): string[] => {
  const urls = new Set<string>();

  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;

    for (const part of message.content) {
      let url: string | undefined;
      if (isImageUrlPart(part)) url = part.image_url.url;
      else if (isFileUrlPart(part)) url = part.file_url.url;
      if (!url || isDataUri(url) || !isOwnDeploymentFileUrl(url, origins)) continue;
      urls.add(url);
    }
  }

  return [...urls];
};

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) return [];

  const results: R[] = Array.from({ length: items.length });
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index] as T);
      }
    }),
  );

  return results;
};

const safeResolve = async (
  url: string,
  resolver: OwnOriginAttachmentResolver,
): Promise<OwnOriginAttachmentBytes | null> => {
  try {
    return await resolver(url);
  } catch (error) {
    log(
      'failed to resolve attachment host=%s error=%s',
      sanitizedUrlHost(url),
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};

const applyInlinedUrl = (
  url: string,
  resolved: OwnOriginAttachmentBytes | null,
  maxBytes: number,
): string => {
  if (!resolved) return url;
  if (resolved.bytes.byteLength > maxBytes) {
    log(
      'skip inlining over-cap attachment host=%s size=%d max=%d',
      sanitizedUrlHost(url),
      resolved.bytes.byteLength,
      maxBytes,
    );
    return url;
  }

  return toDataUri(resolved.mimeType || 'application/octet-stream', resolved.bytes);
};

/**
 * Rewrite own-deployment file URLs in an image-edit `imageUrls` list to data
 * URIs. Foreign URLs, data URIs, over-cap files, and resolver failures are
 * left unchanged. Does not mutate `urls`.
 */
export const inlineOwnOriginImageUrls = async (
  urls: readonly string[],
  resolver: OwnOriginAttachmentResolver,
  origins: OwnDeploymentOrigins,
): Promise<string[]> => {
  const uniqueOwnOriginUrls = [
    ...new Set(urls.filter((url) => !isDataUri(url) && isOwnDeploymentFileUrl(url, origins))),
  ];
  if (uniqueOwnOriginUrls.length === 0) return [...urls];

  const resolvedByUrl = new Map<string, OwnOriginAttachmentBytes | null>();
  await mapWithConcurrency(uniqueOwnOriginUrls, INLINE_RESOLVE_CONCURRENCY, async (url) => {
    resolvedByUrl.set(url, await safeResolve(url, resolver));
  });

  return urls.map((url) => {
    if (!resolvedByUrl.has(url)) return url;
    return applyInlinedUrl(url, resolvedByUrl.get(url) ?? null, DEFAULT_IMAGE_INLINE_MAX_BYTES);
  });
};

/**
 * Replace own-deployment file URLs in user messages with data URIs, and strip
 * own-origin `url="…"` attributes from files-prompt text. Mutates `messages`.
 */
export const inlineOwnOriginAttachments = async (
  messages: OpenAIChatMessage[],
  resolver: OwnOriginAttachmentResolver,
  ownOrigins: OwnDeploymentOrigins,
): Promise<void> => {
  for (const message of messages) {
    if (message.role !== 'user') continue;

    if (typeof message.content === 'string') {
      message.content = stripOwnOriginUrlAttributes(message.content, ownOrigins);
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (part.type === 'text') {
        part.text = stripOwnOriginUrlAttributes(part.text, ownOrigins);
      }
    }
  }

  const uniqueUrls = collectOwnOriginAttachmentUrls(messages, ownOrigins);
  if (uniqueUrls.length === 0) return;

  const resolvedByUrl = new Map<string, OwnOriginAttachmentBytes | null>();
  await mapWithConcurrency(uniqueUrls, INLINE_RESOLVE_CONCURRENCY, async (url) => {
    resolvedByUrl.set(url, await safeResolve(url, resolver));
  });

  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (isImageUrlPart(part)) {
        const url = part.image_url.url;
        if (!resolvedByUrl.has(url)) continue;
        part.image_url.url = applyInlinedUrl(
          url,
          resolvedByUrl.get(url) ?? null,
          DEFAULT_IMAGE_INLINE_MAX_BYTES,
        );
        continue;
      }

      if (!isFileUrlPart(part)) continue;
      const url = part.file_url.url;
      if (!resolvedByUrl.has(url)) continue;
      part.file_url.url = applyInlinedUrl(
        url,
        resolvedByUrl.get(url) ?? null,
        DEFAULT_FILE_INLINE_MAX_BYTES,
      );
    }
  }
};

const createFileServiceResolver = (
  input: CreateOwnOriginAttachmentInlineHooksInput,
): OwnOriginAttachmentResolver => {
  let loaded: Promise<{ db: LobeChatDatabase; fileService: FileService }> | undefined;

  const load = () => {
    loaded ??= (async () => {
      const db = await resolveMaybeLazy(input.db ?? getServerDB);
      return {
        db,
        fileService: new FileService(db, input.userId ?? ''),
      };
    })();
    return loaded;
  };

  return async (url) => {
    const { db, fileService } = await load();
    const key = await fileService.getKeyFromFullUrl(url);
    if (!key) {
      log('no storage key for attachment host=%s', sanitizedUrlHost(url));
      return null;
    }

    const bytes = await fileService.getFileByteArray(key);
    if (!bytes?.byteLength) {
      log('empty attachment bytes host=%s', sanitizedUrlHost(url));
      return null;
    }

    const fileId = extractFileProxyId(url);
    const declaredMime = fileId ? (await FileModel.getFileById(db, fileId))?.fileType : undefined;
    const mimeType = await resolveMimeTypeFromBytes(declaredMime, bytes);

    return { bytes, mimeType };
  };
};

/**
 * beforeChat hook that inlines own-deployment attachments via S3 (no HTTP).
 * `db` / `ownOrigins` are resolved lazily on the first payload that has candidates.
 */
export const createOwnOriginAttachmentInlineHooks = (
  input: CreateOwnOriginAttachmentInlineHooksInput,
): ModelRuntimeHooks => ({
  beforeChat: async (payload) => {
    try {
      if (!payload.messages?.length || !hasUserAttachmentCandidates(payload.messages)) return;

      const origins = await resolveMaybeLazy(input.ownOrigins);
      await inlineOwnOriginAttachments(payload.messages, createFileServiceResolver(input), origins);
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
        createFileServiceResolver(input),
        origins,
      );
    } catch (error) {
      log('own-origin imageUrls inline failed: %s', error instanceof Error ? error.message : error);
    }
  },
});
