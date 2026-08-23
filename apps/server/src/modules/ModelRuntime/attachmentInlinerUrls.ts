import type { OpenAIChatMessage, UserMessageContentPart } from '@lobechat/model-runtime';
import { isFileUrlPart } from '@lobechat/model-runtime';
import type { OwnDeploymentOrigins } from '@lobechat/utils';
import { isOwnDeploymentFileUrl, sanitizedUrlHost } from '@lobechat/utils';
import { DEFAULT_IMAGE_INLINE_MAX_BYTES } from '@lobechat/utils/imageToBase64';
import debug from 'debug';

import type {
  OwnOriginAttachmentBytes,
  OwnOriginAttachmentResolver,
} from './attachmentInlinerTypes';

const log = debug('lobe-server:attachment-inliner');

const INLINE_RESOLVE_CONCURRENCY = 4;
const FILE_PROXY_PATH = /^\/f\/([^/]+)$/;
const ATTACHMENT_MESSAGE_ROLES = new Set(['assistant', 'user']);
const filesInfoBlockRe = () => /<files_info>([\s\S]*?)<\/files_info>/g;

export const isImageUrlPart = (
  part: UserMessageContentPart,
): part is Extract<UserMessageContentPart, { type: 'image_url' }> =>
  part.type === 'image_url' && typeof part.image_url?.url === 'string';

export const countImageUrlParts = (message: OpenAIChatMessage | undefined): number => {
  if (!message || !Array.isArray(message.content)) return 0;
  return message.content.filter(isImageUrlPart).length;
};

export const isDataUri = (url: string): boolean => url.startsWith('data:');

export const toDataUri = (mimeType: string, bytes: Uint8Array): string =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;

export const normalizeMime = (mimeType: string | undefined): string =>
  mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
export const extractFileProxyId = (url: string): string | undefined => {
  try {
    const match = FILE_PROXY_PATH.exec(new URL(url).pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
};

export const collectFileUrlFileIds = (parts: UserMessageContentPart[]): Set<string> => {
  const ids = new Set<string>();
  for (const part of parts) {
    if (!isFileUrlPart(part)) continue;
    const fileId = part.file_url.fileId ?? extractFileProxyId(part.file_url.url);
    if (fileId) ids.add(fileId);
  }
  return ids;
};

/** Only APP_URL / INTERNAL_APP_URL `/f/<id>` rules — never S3 endpoint or public-domain URLs. */
export const appFileOrigins = (origins: OwnDeploymentOrigins): OwnDeploymentOrigins => ({
  rewrite: origins.rewrite,
  rules: origins.rules.filter((rule) => rule.path.type === 'app-file'),
});

export const isResolvableAppFileUrl = (url: string, origins: OwnDeploymentOrigins): boolean =>
  Boolean(extractFileProxyId(url)) && isOwnDeploymentFileUrl(url, appFileOrigins(origins));

export const stripOwnOriginUrlAttributes = (text: string, origins: OwnDeploymentOrigins): string =>
  text.replaceAll(/ url="([^"]+)"/g, (matched, url: string) =>
    isOwnDeploymentFileUrl(url, origins) ? '' : matched,
  );

/**
 * Own-origin `url="…"` attributes are injected only inside `<files_info>` blocks
 * (`packages/prompts/src/prompts/files/index.ts`). Never rewrite ordinary user text.
 */
export const stripOwnOriginUrlAttributesInFilesInfo = (
  text: string,
  origins: OwnDeploymentOrigins,
): string => {
  if (!text.includes('<files_info>')) return text;

  return text.replaceAll(filesInfoBlockRe(), (_block, inner: string) => {
    const stripped = stripOwnOriginUrlAttributes(inner, origins);
    return `<files_info>${stripped}</files_info>`;
  });
};

export const hasDocumentPageImageMarkers = (messages: OpenAIChatMessage[]): boolean => {
  for (const message of messages) {
    const { content } = message;
    if (typeof content === 'string' && content.includes('<document_page_image')) return true;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === 'text' && part.text.includes('<document_page_image')) return true;
    }
  }
  return false;
};
export const hasAttachmentCandidates = (messages: OpenAIChatMessage[]): boolean => {
  if (hasDocumentPageImageMarkers(messages)) return true;

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

export const collectOwnOriginAttachmentUrls = (
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

export const mapWithConcurrency = async <T, R>(
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

export const safeResolve = async (
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
export const takeIfWithinCap = (
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

export const applyInlinedUrl = (
  url: string,
  resolved: OwnOriginAttachmentBytes | null,
  maxBytes: number,
): string => {
  const usable = takeIfWithinCap(url, resolved, maxBytes);
  if (!usable) return url;
  return toDataUri(usable.mimeType || 'application/octet-stream', usable.bytes);
};

export const resolveUniqueUrls = async (
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
