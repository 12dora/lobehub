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

import { renderPdfPagesToPng } from './pdfPageImages';

const log = debug('lobe-server:attachment-inliner');

const INLINE_RESOLVE_CONCURRENCY = 4;
const FILE_PROXY_PATH = /^\/f\/([^/]+)$/;
const PDF_MIME = 'application/pdf';
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const; // %PDF
const IMAGE_ONLY_PDF_MIN_TEXT_CHARS = 20;
const IMAGE_ONLY_PDF_MAX_PAGES = 4;
const IMAGE_ONLY_PDF_MAX_LONG_EDGE_PX = 1800;
const IMAGE_ONLY_PDF_MAX_IMAGES_PER_MESSAGE = 4;
const PAGE_TAG_RE = /<\/?page\b[^>]*>/gi;

const ATTACHMENT_MESSAGE_ROLES = new Set(['assistant', 'user']);

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
  ownOrigins: MaybeLazy<OwnDeploymentOrigins>;
  userId?: string;
}

export interface InlineOwnOriginAttachmentsOptions {
  fileMaxBytes?: number;
  imageMaxBytes?: number;
  /** Resolves a `files` row by id (FileModel + FileService). Used for `<files_info>` PDFs. */
  resolveByFileId?: OwnOriginFileIdResolver;
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

const normalizeMime = (mimeType: string | undefined): string =>
  mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';

const hasPdfMagic = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= PDF_MAGIC.length &&
  bytes[0] === PDF_MAGIC[0] &&
  bytes[1] === PDF_MAGIC[1] &&
  bytes[2] === PDF_MAGIC[2] &&
  bytes[3] === PDF_MAGIC[3];

const isPdfBytes = (
  declaredMime: string | undefined,
  resolvedMime: string | undefined,
  bytes: Uint8Array,
): boolean =>
  normalizeMime(declaredMime) === PDF_MIME ||
  normalizeMime(resolvedMime) === PDF_MIME ||
  hasPdfMagic(bytes);

/** Image-only = missing extracted text, or only `<page>` tags / whitespace under 20 chars. */
const isImageOnlyPdfContent = (content: string | undefined): boolean => {
  if (!content) return true;
  const stripped = content.replaceAll(PAGE_TAG_RE, '').replaceAll(/\s+/g, '');
  return stripped.length < IMAGE_ONLY_PDF_MIN_TEXT_CHARS;
};

const imageOnlyPdfNotice = (name: string): string =>
  `[PDF "${name}" has no text layer; its pages are attached above as images]`;

interface FilesInfoEmptyPdf {
  fileId: string;
  name: string;
}

/**
 * Empty-text PDFs inside `<files_info>` (with or without `sandboxPath` / `url`).
 * Id must match `file_[A-Za-z0-9]+` — the live files-row prefix.
 */
const collectEmptyTextPdfsFromFilesInfo = (text: string): FilesInfoEmptyPdf[] => {
  if (!text.includes('<files_info>')) return [];

  const found: FilesInfoEmptyPdf[] = [];
  const seen = new Set<string>();

  for (const block of text.matchAll(/<files_info>([\s\S]*?)<\/files_info>/g)) {
    const inner = block[1] ?? '';
    for (const tag of inner.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/gi)) {
      const attrs = tag[1] ?? '';
      const body = tag[2] ?? '';
      const fileId = /\bid="(file_[A-Za-z0-9]+)"/.exec(attrs)?.[1];
      const type = /\btype="([^"]*)"/.exec(attrs)?.[1];
      if (!fileId || seen.has(fileId)) continue;
      if (normalizeMime(type) !== PDF_MIME) continue;
      if (!isImageOnlyPdfContent(body)) continue;
      seen.add(fileId);
      found.push({ fileId, name: /\bname="([^"]*)"/.exec(attrs)?.[1] || fileId });
    }
  }

  return found;
};

interface RasterizedPdfImages {
  dataUris: string[];
}

const rasterizeImageOnlyPdf = async (
  bytes: Uint8Array,
  imageMaxBytes: number,
): Promise<RasterizedPdfImages> => {
  try {
    const pages = await renderPdfPagesToPng(bytes, {
      maxBytesPerImage: imageMaxBytes,
      maxLongEdgePx: IMAGE_ONLY_PDF_MAX_LONG_EDGE_PX,
      maxPages: IMAGE_ONLY_PDF_MAX_PAGES,
    });
    const dataUris = pages.map((page) => toDataUri('image/png', page.png));
    return { dataUris };
  } catch (error) {
    log('image-only PDF rasterize failed: %s', error instanceof Error ? error.message : error);
    console.error('image-only PDF rasterize failed', error);
    return { dataUris: [] };
  }
};

const extractFileProxyId = (url: string): string | undefined => {
  try {
    const match = FILE_PROXY_PATH.exec(new URL(url).pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
};

const collectFileUrlFileIds = (parts: UserMessageContentPart[]): Set<string> => {
  const ids = new Set<string>();
  for (const part of parts) {
    if (!isFileUrlPart(part)) continue;
    const fileId = part.file_url.fileId ?? extractFileProxyId(part.file_url.url);
    if (fileId) ids.add(fileId);
  }
  return ids;
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
 * with data URIs, strip own-origin `url="…"` attributes from `<files_info>`
 * blocks in user text only, and rasterize empty-text PDFs that arrive only as
 * `<files_info>` markup (no `file_url` part). Mutates `messages`.
 */
export const inlineOwnOriginAttachments = async (
  messages: OpenAIChatMessage[],
  resolver: OwnOriginAttachmentResolver,
  ownOrigins: OwnDeploymentOrigins,
  options?: InlineOwnOriginAttachmentsOptions,
): Promise<void> => {
  const imageMaxBytes = options?.imageMaxBytes ?? DEFAULT_IMAGE_INLINE_MAX_BYTES;
  const fileMaxBytes = options?.fileMaxBytes ?? DEFAULT_FILE_INLINE_MAX_BYTES;
  const resolveByFileId = options?.resolveByFileId;

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
  const resolvedByUrl =
    maxBytesByUrl.size === 0
      ? new Map<string, OwnOriginAttachmentBytes | null>()
      : await resolveUniqueUrls(maxBytesByUrl, resolver);

  // User messages first so assistant history can reuse the per-fileId memo.
  const rasterMemo = new Map<string, Promise<RasterizedPdfImages>>();
  const fileBytesMemo = new Map<string, Promise<OwnOriginAttachmentBytes | null>>();

  const loadFileBytes = async (fileId: string): Promise<OwnOriginAttachmentBytes | null> => {
    if (!resolveByFileId) return null;
    let pending = fileBytesMemo.get(fileId);
    if (!pending) {
      pending = (async () => {
        try {
          return await resolveByFileId(fileId, fileMaxBytes);
        } catch (error) {
          log(
            'failed to resolve attachment id=%s error=%s',
            fileId,
            error instanceof Error ? error.message : error,
          );
          return null;
        }
      })();
      fileBytesMemo.set(fileId, pending);
    }
    const resolved = await pending;
    if (!resolved) return null;
    if (resolved.bytes.byteLength > fileMaxBytes) {
      log(
        'skip over-cap attachment id=%s size=%d max=%d',
        fileId,
        resolved.bytes.byteLength,
        fileMaxBytes,
      );
      return null;
    }
    return resolved;
  };

  const appendRasterizedPages = async (
    next: UserMessageContentPart[],
    memoKey: string,
    name: string,
    bytes: Uint8Array,
    imageSlots: { remaining: number },
    allowRender: boolean,
  ): Promise<boolean> => {
    if (imageSlots.remaining <= 0) return false;

    let pending = rasterMemo.get(memoKey);
    if (!pending) {
      if (!allowRender) return false;
      pending = rasterizeImageOnlyPdf(bytes, imageMaxBytes);
      rasterMemo.set(memoKey, pending);
    }

    const { dataUris } = await pending;
    const used = dataUris.slice(0, imageSlots.remaining);
    if (used.length === 0) return false;

    for (const dataUri of used) {
      next.push({ image_url: { detail: 'high', url: dataUri }, type: 'image_url' });
    }
    next.push({ text: imageOnlyPdfNotice(name), type: 'text' });
    imageSlots.remaining -= used.length;
    return true;
  };

  const applyInlinedParts = async (role: 'assistant' | 'user') => {
    const allowRender = role === 'user';

    for (const message of messages) {
      if (message.role !== role || !Array.isArray(message.content)) continue;

      const existingImages = message.content.filter(isImageUrlPart).length;
      const imageSlots = { remaining: IMAGE_ONLY_PDF_MAX_IMAGES_PER_MESSAGE - existingImages };
      const next: UserMessageContentPart[] = [];

      for (const part of message.content) {
        if (isImageUrlPart(part)) {
          const url = part.image_url.url;
          if (resolvedByUrl.has(url)) {
            part.image_url.url = applyInlinedUrl(
              url,
              resolvedByUrl.get(url) ?? null,
              imageMaxBytes,
            );
          }
          next.push(part);
          continue;
        }

        if (!isFileUrlPart(part)) {
          next.push(part);
          continue;
        }

        const url = part.file_url.url;
        const resolved = resolvedByUrl.has(url) ? (resolvedByUrl.get(url) ?? null) : null;
        if (resolvedByUrl.has(url)) {
          part.file_url.url = applyInlinedUrl(url, resolved, fileMaxBytes);
        }
        next.push(part);

        if (!resolved) continue;
        if (resolved.bytes.byteLength > fileMaxBytes) continue;
        if (!isPdfBytes(part.file_url.mimeType, resolved.mimeType, resolved.bytes)) continue;
        if (!isImageOnlyPdfContent(part.file_url.content)) continue;

        const memoKey = part.file_url.fileId ?? url;
        await appendRasterizedPages(
          next,
          memoKey,
          part.file_url.name,
          resolved.bytes,
          imageSlots,
          allowRender,
        );
      }

      message.content = next;
    }
  };

  const applyFilesInfoRasterization = async () => {
    if (!resolveByFileId) return;

    for (const message of messages) {
      if (message.role !== 'user') continue;

      try {
        const content = message.content;
        const texts: string[] = [];
        if (typeof content === 'string') {
          if (!content.includes('<files_info>')) continue;
          texts.push(content);
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'text' && part.text.includes('<files_info>')) texts.push(part.text);
          }
          if (texts.length === 0) continue;
        } else {
          continue;
        }

        const handled = Array.isArray(content) ? collectFileUrlFileIds(content) : new Set<string>();
        const candidates: FilesInfoEmptyPdf[] = [];
        const seen = new Set<string>();
        for (const text of texts) {
          for (const pdf of collectEmptyTextPdfsFromFilesInfo(text)) {
            if (handled.has(pdf.fileId) || seen.has(pdf.fileId)) continue;
            seen.add(pdf.fileId);
            candidates.push(pdf);
          }
        }
        if (candidates.length === 0) continue;

        const existingImages = Array.isArray(content) ? content.filter(isImageUrlPart).length : 0;
        const imageSlots = { remaining: IMAGE_ONLY_PDF_MAX_IMAGES_PER_MESSAGE - existingImages };
        if (imageSlots.remaining <= 0) continue;

        const next: UserMessageContentPart[] =
          typeof content === 'string' ? [{ text: content, type: 'text' }] : [...content];
        let appended = false;

        for (const pdf of candidates) {
          if (imageSlots.remaining <= 0) break;
          const resolved = await loadFileBytes(pdf.fileId);
          if (!resolved) continue;
          if (!isPdfBytes(undefined, resolved.mimeType, resolved.bytes)) continue;
          appended =
            (await appendRasterizedPages(
              next,
              pdf.fileId,
              pdf.name,
              resolved.bytes,
              imageSlots,
              true,
            )) || appended;
        }

        if (appended) message.content = next;
      } catch (error) {
        log(
          'files_info image-only PDF inline failed: %s',
          error instanceof Error ? error.message : error,
        );
      }
    }
  };

  await applyInlinedParts('user');
  await applyFilesInfoRasterization();
  await applyInlinedParts('assistant');
};

const createFileServiceResolvers = (
  input: CreateOwnOriginAttachmentInlineHooksInput,
  origins: OwnDeploymentOrigins,
): { resolveByFileId: OwnOriginFileIdResolver; resolveByUrl: OwnOriginAttachmentResolver } => {
  let loaded: Promise<{ db: LobeChatDatabase; fileService: FileService }> | undefined;
  const byFileId = new Map<string, Promise<OwnOriginAttachmentBytes | null>>();

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

  const resolveByFileId: OwnOriginFileIdResolver = async (fileId, maxBytes) => {
    const memoKey = `${fileId}:${maxBytes}`;
    const existing = byFileId.get(memoKey);
    if (existing) return existing;

    const pending = (async (): Promise<OwnOriginAttachmentBytes | null> => {
      try {
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
    })();

    byFileId.set(memoKey, pending);
    return pending;
  };

  const resolveByUrl: OwnOriginAttachmentResolver = async (url, maxBytes) => {
    if (!isResolvableAppFileUrl(url, origins)) {
      log('skip non-app-file attachment host=%s', sanitizedUrlHost(url));
      return null;
    }

    const fileId = extractFileProxyId(url);
    if (!fileId) return null;
    return resolveByFileId(fileId, maxBytes);
  };

  return { resolveByFileId, resolveByUrl };
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
        const resolvers = createFileServiceResolvers(input, origins);
        await inlineOwnOriginAttachments(payload.messages, resolvers.resolveByUrl, origins, {
          imageMaxBytes,
          resolveByFileId: resolvers.resolveByFileId,
        });
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
          createFileServiceResolvers(input, origins).resolveByUrl,
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
