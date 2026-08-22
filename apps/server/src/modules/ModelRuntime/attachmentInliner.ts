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

const ATTACHMENT_MESSAGE_ROLES = new Set(['assistant', 'user']);

export interface OwnOriginAttachmentBytes {
  bytes: Uint8Array;
  mimeType: string;
}

export type OwnOriginAttachmentResolver = (
  url: string,
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
  ownOrigins: MaybeLazy<OwnDeploymentOrigins>;
  userId?: string;
}

export interface InlineOwnOriginAttachmentsOptions {
  fileMaxBytes?: number;
  imageMaxBytes?: number;
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

/** Only APP_URL / INTERNAL_APP_URL `/f/<id>` rules — never S3 endpoint or public-domain URLs. */
const appFileOrigins = (origins: OwnDeploymentOrigins): OwnDeploymentOrigins => ({
  rewrite: origins.rewrite,
  rules: origins.rules.filter((rule) => rule.path.type === 'app-file'),
});

const isResolvableAppFileUrl = (url: string, origins: OwnDeploymentOrigins): boolean =>
  Boolean(extractFileProxyId(url)) && isOwnDeploymentFileUrl(url, appFileOrigins(origins));

const stripOwnOriginUrlAttributes = (text: string, origins: OwnDeploymentOrigins): string =>
  text.replaceAll(/ url="([^"]+)"/g, (matched, url: string) =>
    isOwnDeploymentFileUrl(url, origins) ? '' : matched,
  );

/**
 * Own-origin `url="…"` attributes are injected only inside `<files_info>` blocks
 * (`packages/prompts/src/prompts/files/index.ts`). Never rewrite ordinary user text.
 */
const stripOwnOriginUrlAttributesInFilesInfo = (
  text: string,
  origins: OwnDeploymentOrigins,
): string => {
  if (!text.includes('<files_info>')) return text;

  return text.replaceAll(/<files_info>([\s\S]*?)<\/files_info>/g, (_block, inner: string) => {
    const stripped = stripOwnOriginUrlAttributes(inner, origins);
    return `<files_info>${stripped}</files_info>`;
  });
};

const hasAttachmentCandidates = (messages: OpenAIChatMessage[]): boolean => {
  for (const message of messages) {
    const { content } = message;
    if (typeof content === 'string') {
      if (message.role === 'user' && content.includes('<files_info>')) return true;
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (part.type === 'text' && message.role === 'user' && part.text.includes('<files_info>')) {
        return true;
      }
      if (!ATTACHMENT_MESSAGE_ROLES.has(message.role)) continue;
      if (isImageUrlPart(part) && part.image_url.url && !isDataUri(part.image_url.url)) return true;
      if (isFileUrlPart(part) && !isDataUri(part.file_url.url)) return true;
    }
  }

  return false;
};

const collectOwnOriginAttachmentUrls = (
  messages: OpenAIChatMessage[],
  origins: OwnDeploymentOrigins,
  caps: { fileMaxBytes: number; imageMaxBytes: number },
): Map<string, number> => {
  const maxBytesByUrl = new Map<string, number>();

  const add = (url: string | undefined, maxBytes: number) => {
    if (!url || isDataUri(url) || !isResolvableAppFileUrl(url, origins)) return;
    const previous = maxBytesByUrl.get(url);
    maxBytesByUrl.set(url, previous === undefined ? maxBytes : Math.max(previous, maxBytes));
  };

  for (const message of messages) {
    if (!ATTACHMENT_MESSAGE_ROLES.has(message.role) || !Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (isImageUrlPart(part)) add(part.image_url.url, caps.imageMaxBytes);
      else if (isFileUrlPart(part)) add(part.file_url.url, caps.fileMaxBytes);
    }
  }

  return maxBytesByUrl;
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
  maxBytes: number,
  resolver: OwnOriginAttachmentResolver,
): Promise<OwnOriginAttachmentBytes | null> => {
  try {
    return await resolver(url, maxBytes);
  } catch (error) {
    log(
      'failed to resolve attachment host=%s error=%s',
      sanitizedUrlHost(url),
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};

/** Drop over-cap buffers immediately so they are not retained in the memo map. */
const takeIfWithinCap = (
  url: string,
  resolved: OwnOriginAttachmentBytes | null,
  maxBytes: number,
): OwnOriginAttachmentBytes | null => {
  if (!resolved) return null;
  if (resolved.bytes.byteLength > maxBytes) {
    log(
      'skip inlining over-cap attachment host=%s size=%d max=%d',
      sanitizedUrlHost(url),
      resolved.bytes.byteLength,
      maxBytes,
    );
    return null;
  }

  return resolved;
};

const applyInlinedUrl = (
  url: string,
  resolved: OwnOriginAttachmentBytes | null,
  maxBytes: number,
): string => {
  const usable = takeIfWithinCap(url, resolved, maxBytes);
  if (!usable) return url;
  return toDataUri(usable.mimeType || 'application/octet-stream', usable.bytes);
};

const resolveUniqueUrls = async (
  maxBytesByUrl: Map<string, number>,
  resolver: OwnOriginAttachmentResolver,
): Promise<Map<string, OwnOriginAttachmentBytes | null>> => {
  const resolvedByUrl = new Map<string, OwnOriginAttachmentBytes | null>();
  const entries = [...maxBytesByUrl.entries()];

  await mapWithConcurrency(entries, INLINE_RESOLVE_CONCURRENCY, async ([url, maxBytes]) => {
    const resolved = await safeResolve(url, maxBytes, resolver);
    resolvedByUrl.set(url, takeIfWithinCap(url, resolved, maxBytes));
  });

  return resolvedByUrl;
};

/**
 * Rewrite own-deployment app-file URLs in an image-edit `imageUrls` list to data
 * URIs. Foreign URLs, data URIs, S3/presigned URLs, over-cap files, and resolver
 * failures are left unchanged. Does not mutate `urls`.
 */
export const inlineOwnOriginImageUrls = async (
  urls: readonly string[],
  resolver: OwnOriginAttachmentResolver,
  origins: OwnDeploymentOrigins,
  imageMaxBytes: number = DEFAULT_IMAGE_INLINE_MAX_BYTES,
): Promise<string[]> => {
  const maxBytesByUrl = new Map<string, number>();
  for (const url of urls) {
    if (isDataUri(url) || !isResolvableAppFileUrl(url, origins)) continue;
    maxBytesByUrl.set(url, imageMaxBytes);
  }
  if (maxBytesByUrl.size === 0) return [...urls];

  const resolvedByUrl = await resolveUniqueUrls(maxBytesByUrl, resolver);

  return urls.map((url) => {
    if (!resolvedByUrl.has(url)) return url;
    return applyInlinedUrl(url, resolvedByUrl.get(url) ?? null, imageMaxBytes);
  });
};

/**
 * Replace own-deployment `/f/<id>` URLs in user and assistant structured parts
 * with data URIs, and strip own-origin `url="…"` attributes from `<files_info>`
 * blocks in user text only. Mutates `messages`.
 */
export const inlineOwnOriginAttachments = async (
  messages: OpenAIChatMessage[],
  resolver: OwnOriginAttachmentResolver,
  ownOrigins: OwnDeploymentOrigins,
  options?: InlineOwnOriginAttachmentsOptions,
): Promise<void> => {
  const imageMaxBytes = options?.imageMaxBytes ?? DEFAULT_IMAGE_INLINE_MAX_BYTES;
  const fileMaxBytes = options?.fileMaxBytes ?? DEFAULT_FILE_INLINE_MAX_BYTES;

  for (const message of messages) {
    if (message.role !== 'user') continue;

    if (typeof message.content === 'string') {
      message.content = stripOwnOriginUrlAttributesInFilesInfo(message.content, ownOrigins);
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (part.type === 'text') {
        part.text = stripOwnOriginUrlAttributesInFilesInfo(part.text, ownOrigins);
      }
    }
  }

  const maxBytesByUrl = collectOwnOriginAttachmentUrls(messages, ownOrigins, {
    fileMaxBytes,
    imageMaxBytes,
  });
  if (maxBytesByUrl.size === 0) return;

  const resolvedByUrl = await resolveUniqueUrls(maxBytesByUrl, resolver);

  for (const message of messages) {
    if (!ATTACHMENT_MESSAGE_ROLES.has(message.role) || !Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (isImageUrlPart(part)) {
        const url = part.image_url.url;
        if (!resolvedByUrl.has(url)) continue;
        part.image_url.url = applyInlinedUrl(url, resolvedByUrl.get(url) ?? null, imageMaxBytes);
        continue;
      }

      if (!isFileUrlPart(part)) continue;
      const url = part.file_url.url;
      if (!resolvedByUrl.has(url)) continue;
      part.file_url.url = applyInlinedUrl(url, resolvedByUrl.get(url) ?? null, fileMaxBytes);
    }
  }
};

const createFileServiceResolver = (
  input: CreateOwnOriginAttachmentInlineHooksInput,
  origins: OwnDeploymentOrigins,
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

  return async (url, maxBytes) => {
    if (!isResolvableAppFileUrl(url, origins)) {
      log('skip non-app-file attachment host=%s', sanitizedUrlHost(url));
      return null;
    }

    const fileId = extractFileProxyId(url);
    if (!fileId) return null;

    const { db, fileService } = await load();
    const file = await FileModel.getFileById(db, fileId);
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
      log('empty attachment bytes host=%s', sanitizedUrlHost(url));
      return null;
    }

    if (bytes.byteLength > maxBytes) {
      log(
        'skip over-cap attachment host=%s size=%d max=%d',
        sanitizedUrlHost(url),
        bytes.byteLength,
        maxBytes,
      );
      return null;
    }

    const mimeType = await resolveMimeTypeFromBytes(file.fileType, bytes);
    return { bytes, mimeType };
  };
};

/**
 * beforeChat / beforeCreateImage hooks that inline own-deployment `/f/<id>`
 * attachments via FileModel + S3 (no HTTP, no raw S3 URL resolution).
 * `db` / `ownOrigins` are resolved lazily on the first payload that has candidates.
 */
export const createOwnOriginAttachmentInlineHooks = (
  input: CreateOwnOriginAttachmentInlineHooksInput,
): ModelRuntimeHooks => {
  const imageMaxBytes = input.imageMaxBytes ?? DEFAULT_IMAGE_INLINE_MAX_BYTES;

  return {
    beforeChat: async (payload) => {
      try {
        if (!payload.messages?.length || !hasAttachmentCandidates(payload.messages)) return;

        const origins = await resolveMaybeLazy(input.ownOrigins);
        await inlineOwnOriginAttachments(
          payload.messages,
          createFileServiceResolver(input, origins),
          origins,
          { imageMaxBytes },
        );
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
          createFileServiceResolver(input, origins),
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
