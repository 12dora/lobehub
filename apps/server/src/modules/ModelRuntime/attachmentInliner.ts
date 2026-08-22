import {
  PAGE_IMAGES_SHOWN_EARLIER,
  parseDocumentPageImageMarkers,
  replaceDocumentPageImageMarkers,
} from '@lobechat/builtin-tool-document-pages';
import type {
  ModelRuntimeHooks,
  OpenAIChatMessage,
  UserMessageContentPart,
} from '@lobechat/model-runtime';
import { isFileUrlPart } from '@lobechat/model-runtime';
import type { FileRenderMetadata } from '@lobechat/types';
import { DOCUMENT_RENDER_DEFAULTS, readFileRenderMetadata } from '@lobechat/types';
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

import {
  collectAttachedDocumentFiles,
  collectUserText,
  selectDocumentFeed,
} from './documentFeed';
import { renderPdfPagesToPng } from './pdfPageImages';

const log = debug('lobe-server:attachment-inliner');

const INLINE_RESOLVE_CONCURRENCY = 4;
const FILE_PROXY_PATH = /^\/f\/([^/]+)$/;
const PDF_MIME = 'application/pdf';
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const; // %PDF
const FILE_ID_IN_ATTR_RE = /[\w-]{6,128}/;
const IMAGE_ONLY_PDF_MIN_TEXT_CHARS = 20;
const IMAGE_ONLY_PDF_MAX_PAGES = 4;
const IMAGE_ONLY_PDF_MAX_LONG_EDGE_PX = 1800;
const IMAGE_ONLY_PDF_MAX_IMAGES_PER_MESSAGE = 6;
const IMAGE_ONLY_PDF_TILE_GRID = 2 as const;
const PAYLOAD_MAX_RASTERIZED_PDFS = 2;
const PAYLOAD_MAX_RASTERIZED_IMAGES = 6;
const PAGE_TAG_RE = /<\/?page\b[^>]*>/gi;

const filesInfoBlockRe = () => /<files_info>([\s\S]*?)<\/files_info>/g;

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
  /**
   * Per-message rasterized PDF image ceiling. Cursor's CLI transport rejects
   * more than 4 images; other providers use 6 (page + four quadrant tiles).
   */
  imageMaxCount?: number;
  ownOrigins: MaybeLazy<OwnDeploymentOrigins>;
  /** When false (Cursor), document-feed notices tell the model to name pages. */
  tools?: boolean;
  userId?: string;
}

export interface InlineOwnOriginAttachmentsOptions {
  fileMaxBytes?: number;
  imageMaxBytes?: number;
  imageMaxCount?: number;
  /** Load a render artifact PNG by object key (FileService.getFileByteArray). */
  loadArtifact?: (key: string) => Promise<Uint8Array | null>;
  /** files.metadata.render for an attached file id. */
  loadRender?: (fileId: string) => Promise<FileRenderMetadata | undefined>;
  maxDocsPerRequest?: number;
  /** Resolves a `files` row by id (FileModel + FileService). Used for `<files_info>` PDFs. */
  resolveByFileId?: OwnOriginFileIdResolver;
  tools?: boolean;
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

const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

const strippedPdfTextLength = (content: string | undefined): number => {
  if (!content) return 0;
  return content.replaceAll(PAGE_TAG_RE, '').replaceAll(/\s+/g, '').length;
};

type PdfTextKind = 'empty' | 'sparse' | 'rich';

const pdfTextKind = (content: string | undefined): PdfTextKind => {
  const length = strippedPdfTextLength(content);
  if (length === 0) return 'empty';
  if (length < IMAGE_ONLY_PDF_MIN_TEXT_CHARS) return 'sparse';
  return 'rich';
};

const imageOnlyPdfNotice = (
  name: string,
  tilesAttached: boolean,
  textKind: Exclude<PdfTextKind, 'rich'>,
): string => {
  const tileClause = tilesAttached
    ? ' The page is followed by four zoomed quadrant tiles (top-left, top-right, bottom-left, bottom-right).'
    : '';
  if (textKind === 'sparse') {
    return `[PDF "${name}" text layer is sparse; pages attached as images — read the page images directly.${tileClause} Do not try to read or re-parse this file with tools.]`;
  }
  return `[PDF "${name}" is a scanned document with no text layer. Its pages are attached above as images — read the page images directly.${tileClause} Do not try to read or re-parse this file with tools; extracted text will always be empty.]`;
};

/**
 * Rewrite the empty `<file …>` body of an image-only PDF, only inside
 * `<files_info>` blocks, so an agent loop does not "read the file" with tools
 * (and trust the empty text) instead of looking at the attached page images.
 * Never touches free user text that happens to contain a `<file>` tag.
 */
const markImageOnlyPdfInFilesInfo = (text: string, fileId: string): string => {
  if (!text.includes('<files_info>')) return text;

  const fileRe = new RegExp(
    `(<file\\b[^>]*\\bid="${escapeRegExp(fileId)}"[^>]*>)([\\s\\S]*?)(</file>)`,
    'i',
  );

  return text.replaceAll(filesInfoBlockRe(), (_block, inner: string) => {
    const marked = inner.replace(
      fileRe,
      (_m, open: string, _body: string, close: string) =>
        `${open}[scanned document: no text layer; its pages are attached to this message as images — read the images, do not re-read this file with tools]${close}`,
    );
    return `<files_info>${marked}</files_info>`;
  });
};

interface FilesInfoImageOnlyPdf {
  fileId: string;
  name: string;
  textKind: Exclude<PdfTextKind, 'rich'>;
}

/**
 * Image-only PDFs inside `<files_info>` (with or without `sandboxPath` / `url`).
 * Id is `[A-Za-z0-9_-]{6,128}` — FileModel lookup is the real validation
 * (bot/IM uploads use UUID ids from `uploadFromBuffer`).
 */
const collectImageOnlyPdfsFromFilesInfo = (text: string): FilesInfoImageOnlyPdf[] => {
  if (!text.includes('<files_info>')) return [];

  const found: FilesInfoImageOnlyPdf[] = [];
  const seen = new Set<string>();
  const fileIdRe = new RegExp(`\\bid="(${FILE_ID_IN_ATTR_RE.source})"`);

  for (const block of text.matchAll(filesInfoBlockRe())) {
    const inner = block[1] ?? '';
    for (const tag of inner.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/gi)) {
      const attrs = tag[1] ?? '';
      const body = tag[2] ?? '';
      const fileId = fileIdRe.exec(attrs)?.[1];
      const type = /\btype="([^"]*)"/.exec(attrs)?.[1];
      if (!fileId || seen.has(fileId)) continue;
      if (normalizeMime(type) !== PDF_MIME) continue;
      const textKind = pdfTextKind(body);
      if (textKind === 'rich') continue;
      seen.add(fileId);
      found.push({
        fileId,
        name: /\bname="([^"]*)"/.exec(attrs)?.[1] || fileId,
        textKind,
      });
    }
  }

  return found;
};

interface RasterizedPdfImage {
  dataUri: string;
  kind: 'page' | 'tile';
  page: number;
}

interface RasterizedPdfImages {
  images: RasterizedPdfImage[];
}

const selectRasterizedImages = (
  images: RasterizedPdfImage[],
  remaining: number,
): RasterizedPdfImage[] => {
  if (remaining <= 0) return [];

  const pages = images.filter((image) => image.kind === 'page');
  const uniquePages = new Set(pages.map((image) => image.page));
  if (uniquePages.size !== 1) return pages.slice(0, remaining);

  const tiles = images.filter((image) => image.kind === 'tile');
  return [...pages, ...tiles].slice(0, remaining);
};

const rasterizeImageOnlyPdf = async (
  bytes: Uint8Array,
  imageMaxBytes: number,
): Promise<RasterizedPdfImages> => {
  try {
    const pages = await renderPdfPagesToPng(bytes, {
      maxBytesPerImage: imageMaxBytes,
      maxLongEdgePx: IMAGE_ONLY_PDF_MAX_LONG_EDGE_PX,
      maxPages: IMAGE_ONLY_PDF_MAX_PAGES,
      tiles: {
        grid: IMAGE_ONLY_PDF_TILE_GRID,
        maxLongEdgePx: IMAGE_ONLY_PDF_MAX_LONG_EDGE_PX,
      },
    });
    return {
      images: pages.map((page) => ({
        dataUri: toDataUri('image/png', page.png),
        kind: page.kind === 'tile' ? 'tile' : 'page',
        page: page.page,
      })),
    };
  } catch (error) {
    log('image-only PDF rasterize failed: %s', error instanceof Error ? error.message : error);
    console.error('image-only PDF rasterize failed', error);
    return { images: [] };
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

  return text.replaceAll(filesInfoBlockRe(), (_block, inner: string) => {
    const stripped = stripOwnOriginUrlAttributes(inner, origins);
    return `<files_info>${stripped}</files_info>`;
  });
};

const hasDocumentPageImageMarkers = (messages: OpenAIChatMessage[]): boolean => {
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

const toolMessageText = (message: OpenAIChatMessage): string | undefined => {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const texts = message.content.filter((part) => part.type === 'text').map((part) => part.text);
  return texts.length > 0 ? texts.join('\n') : undefined;
};

const setToolMessageText = (message: OpenAIChatMessage, text: string) => {
  if (typeof message.content === 'string' || !Array.isArray(message.content)) {
    message.content = text;
    return;
  }
  const next: UserMessageContentPart[] = [{ text, type: 'text' }];
  for (const part of message.content) {
    if (part.type !== 'text') next.push(part);
  }
  message.content = next.length === 1 ? text : next;
};

const artifactToDataUri = (
  bytes: Uint8Array | null,
  imageMaxBytes: number,
): string | undefined => {
  if (!bytes?.byteLength || bytes.byteLength > imageMaxBytes) return undefined;
  return toDataUri('image/png', bytes);
};

const hasAttachmentCandidates = (messages: OpenAIChatMessage[]): boolean => {
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
  const imageMaxCount = options?.imageMaxCount ?? IMAGE_ONLY_PDF_MAX_IMAGES_PER_MESSAGE;
  const fileMaxBytes = options?.fileMaxBytes ?? DEFAULT_FILE_INLINE_MAX_BYTES;
  const resolveByFileId = options?.resolveByFileId;
  const loadRender = options?.loadRender;
  const loadArtifact = options?.loadArtifact;
  const tools = options?.tools ?? true;
  const maxDocsPerRequest = options?.maxDocsPerRequest ?? DOCUMENT_RENDER_DEFAULTS.maxDocsPerRequest;

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
  const rasterBudget = {
    imagesRemaining: PAYLOAD_MAX_RASTERIZED_IMAGES,
    pdfsRemaining: PAYLOAD_MAX_RASTERIZED_PDFS,
  };

  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserMessageIndex = index;
      break;
    }
  }

  const fedFileIds = new Set<string>();

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

  const dropPdfBytesMemo = (memoKey: string) => {
    fileBytesMemo.delete(memoKey);
  };

  const appendRasterizedPages = async (
    next: UserMessageContentPart[],
    memoKey: string,
    name: string,
    bytes: Uint8Array,
    imageSlots: { remaining: number },
    allowRender: boolean,
    textKind: Exclude<PdfTextKind, 'rich'>,
  ): Promise<boolean> => {
    const remaining = allowRender
      ? Math.min(imageSlots.remaining, rasterBudget.imagesRemaining)
      : imageSlots.remaining;
    if (remaining <= 0) return false;

    let pending = rasterMemo.get(memoKey);
    if (!pending) {
      if (!allowRender) return false;
      if (rasterBudget.pdfsRemaining <= 0) return false;
      rasterBudget.pdfsRemaining -= 1;
      pending = rasterizeImageOnlyPdf(bytes, imageMaxBytes).finally(() => {
        // Keep only data URIs in rasterMemo; drop the raw PDF buffer.
        dropPdfBytesMemo(memoKey);
      });
      rasterMemo.set(memoKey, pending);
    }

    const { images } = await pending;
    const used = selectRasterizedImages(images, remaining);
    if (used.length === 0) return false;

    const tilesAttached = used.some((image) => image.kind === 'tile');
    for (const image of used) {
      next.push({ image_url: { detail: 'high', url: image.dataUri }, type: 'image_url' });
    }
    next.push({ text: imageOnlyPdfNotice(name, tilesAttached, textKind), type: 'text' });
    imageSlots.remaining -= used.length;
    if (allowRender) rasterBudget.imagesRemaining -= used.length;
    return true;
  };

  const applyInlinedParts = async (role: 'assistant' | 'user') => {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message || message.role !== role || !Array.isArray(message.content)) continue;

      const allowRender = role === 'user' && index === lastUserMessageIndex;
      const existingImages = message.content.filter(isImageUrlPart).length;
      const imageSlots = { remaining: imageMaxCount - existingImages };
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

        const textKind = pdfTextKind(part.file_url.content);
        if (textKind === 'rich') continue;

        const memoKey = part.file_url.fileId ?? url;
        if (fedFileIds.has(part.file_url.fileId ?? '') || fedFileIds.has(memoKey)) continue;

        await appendRasterizedPages(
          next,
          memoKey,
          part.file_url.name,
          resolved.bytes,
          imageSlots,
          allowRender,
          textKind,
        );
      }

      message.content = next;
    }
  };

  const applyFilesInfoRasterization = async () => {
    if (!resolveByFileId || lastUserMessageIndex < 0) return;

    const message = messages[lastUserMessageIndex];
    if (!message || message.role !== 'user') return;

    try {
      const content = message.content;
      const texts: string[] = [];
      if (typeof content === 'string') {
        if (!content.includes('<files_info>')) return;
        texts.push(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'text' && part.text.includes('<files_info>')) texts.push(part.text);
        }
        if (texts.length === 0) return;
      } else {
        return;
      }

      const handled = Array.isArray(content) ? collectFileUrlFileIds(content) : new Set<string>();
      const candidates: FilesInfoImageOnlyPdf[] = [];
      const seen = new Set<string>();
      for (const text of texts) {
        for (const pdf of collectImageOnlyPdfsFromFilesInfo(text)) {
          if (handled.has(pdf.fileId) || seen.has(pdf.fileId) || fedFileIds.has(pdf.fileId)) continue;
          seen.add(pdf.fileId);
          candidates.push(pdf);
        }
      }
      if (candidates.length === 0) return;

      const existingImages = Array.isArray(content) ? content.filter(isImageUrlPart).length : 0;
      const imageSlots = { remaining: imageMaxCount - existingImages };
      if (imageSlots.remaining <= 0) return;

      const next: UserMessageContentPart[] =
        typeof content === 'string' ? [{ text: content, type: 'text' }] : [...content];
      let appended = false;

      for (const pdf of candidates) {
        if (imageSlots.remaining <= 0 || rasterBudget.imagesRemaining <= 0) break;
        if (!rasterMemo.has(pdf.fileId) && rasterBudget.pdfsRemaining <= 0) break;

        const resolved = await loadFileBytes(pdf.fileId);
        try {
          if (!resolved) continue;
          if (!isPdfBytes(undefined, resolved.mimeType, resolved.bytes)) continue;
          const didAppend = await appendRasterizedPages(
            next,
            pdf.fileId,
            pdf.name,
            resolved.bytes,
            imageSlots,
            true,
            pdf.textKind,
          );
          if (didAppend && pdf.textKind === 'empty') {
            for (const part of next) {
              if (part.type === 'text' && part.text.includes('<files_info>')) {
                part.text = markImageOnlyPdfInFilesInfo(part.text, pdf.fileId);
              }
            }
          }
          appended = didAppend || appended;
        } finally {
          dropPdfBytesMemo(pdf.fileId);
        }
      }

      if (appended) message.content = next;
    } catch (error) {
      log(
        'files_info image-only PDF inline failed: %s',
        error instanceof Error ? error.message : error,
      );
    }
  };

  const applyDocumentFeed = async () => {
    if (!loadRender || lastUserMessageIndex < 0) return;

    const message = messages[lastUserMessageIndex];
    if (!message || message.role !== 'user') return;

    const files = collectAttachedDocumentFiles(message);
    if (files.length === 0) return;

    try {
      const existingImages = Array.isArray(message.content)
        ? message.content.filter(isImageUrlPart).length
        : 0;
      const remaining = Math.max(0, imageMaxCount - existingImages);
      const feed = await selectDocumentFeed({
        files,
        imageMaxCount: remaining,
        loadRender,
        maxDocsPerRequest,
        tools,
        userText: collectUserText(message),
      });
      for (const id of feed.fedFileIds) fedFileIds.add(id);

      // Page images only ride with the latest user turn; later tool-follow-ups
      // keep fedFileIds so live PDF rasterization is skipped.
      if (lastUserMessageIndex !== messages.length - 1) return;
      if (feed.images.length === 0 && feed.notices.length === 0) return;

      const next: UserMessageContentPart[] =
        typeof message.content === 'string'
          ? [{ text: message.content, type: 'text' }]
          : Array.isArray(message.content)
            ? [...message.content]
            : [];

      for (const image of feed.images) {
        if (!loadArtifact) break;
        try {
          const dataUri = artifactToDataUri(await loadArtifact(image.key), imageMaxBytes);
          if (!dataUri) continue;
          next.push({
            image_url: { detail: image.detail, url: dataUri },
            type: 'image_url',
          });
          rasterBudget.imagesRemaining = Math.max(0, rasterBudget.imagesRemaining - 1);
        } catch (error) {
          log(
            'document-feed artifact load failed key=%s error=%s',
            image.key,
            error instanceof Error ? error.message : error,
          );
        }
      }
      for (const notice of feed.notices) {
        next.push({ text: notice, type: 'text' });
      }
      message.content = next;
    } catch (error) {
      log(
        'document feed failed: %s',
        error instanceof Error ? error.message : error,
      );
    }
  };

  const injectToolPageImages = async () => {
    if (!loadArtifact) return;

    const markerIndexes: number[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message || message.role !== 'tool') continue;
      const text = toolMessageText(message);
      if (text && parseDocumentPageImageMarkers(text).length > 0) markerIndexes.push(index);
    }
    if (markerIndexes.length === 0) return;

    const lastIndex = markerIndexes.at(-1)!;
    const isToolFollowUp = lastUserMessageIndex < lastIndex;

    for (const index of markerIndexes) {
      if (isToolFollowUp && index === lastIndex) continue;
      const message = messages[index];
      if (!message) continue;
      const text = toolMessageText(message);
      if (!text) continue;
      setToolMessageText(message, replaceDocumentPageImageMarkers(text, PAGE_IMAGES_SHOWN_EARLIER));
    }

    if (!isToolFollowUp) return;

    const last = messages[lastIndex];
    if (!last) return;
    const text = toolMessageText(last);
    if (!text) return;

    const markers = parseDocumentPageImageMarkers(text);
    const parts: UserMessageContentPart[] = [];
    const attachedPages: number[] = [];
    for (const marker of markers) {
      if (parts.length >= imageMaxCount) break;
      try {
        const dataUri = artifactToDataUri(await loadArtifact(marker.key), imageMaxBytes);
        if (!dataUri) continue;
        parts.push({
          image_url: { detail: 'high', url: dataUri },
          type: 'image_url',
        });
        attachedPages.push(marker.page);
      } catch (error) {
        log(
          'tool page-image artifact load failed key=%s error=%s',
          marker.key,
          error instanceof Error ? error.message : error,
        );
      }
    }
    if (parts.length === 0) return;

    const nameMatch = /Requested page images for "([^"]+)"/.exec(text);
    const uniquePages = [...new Set(attachedPages)].sort((a, b) => a - b);
    parts.push({
      text: `[Requested page images for "${nameMatch?.[1] ?? markers[0]?.fileId}": pages ${uniquePages.join(', ')}]`,
      type: 'text',
    });
    messages.splice(lastIndex + 1, 0, { content: parts, role: 'user' });
  };

  await applyDocumentFeed();
  await injectToolPageImages();
  await applyInlinedParts('user');
  await applyFilesInfoRasterization();
  await applyInlinedParts('assistant');
};

const createFileServiceResolvers = (
  input: CreateOwnOriginAttachmentInlineHooksInput,
  origins: OwnDeploymentOrigins,
): {
  loadArtifact: (key: string) => Promise<Uint8Array | null>;
  loadRender: (fileId: string) => Promise<FileRenderMetadata | undefined>;
  resolveByFileId: OwnOriginFileIdResolver;
  resolveByUrl: OwnOriginAttachmentResolver;
} => {
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

  const loadRender = async (fileId: string): Promise<FileRenderMetadata | undefined> => {
    try {
      const { db } = await load();
      const file = await FileModel.getFileById(db, fileId);
      return readFileRenderMetadata(file?.metadata);
    } catch (error) {
      log(
        'failed to load render metadata id=%s error=%s',
        fileId,
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
  };

  const loadArtifact = async (key: string): Promise<Uint8Array | null> => {
    try {
      const { fileService } = await load();
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
  };

  return { loadArtifact, loadRender, resolveByFileId, resolveByUrl };
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
  const imageMaxCount = input.imageMaxCount ?? IMAGE_ONLY_PDF_MAX_IMAGES_PER_MESSAGE;
  const tools = input.tools ?? true;

  return {
    beforeChat: async (payload) => {
      try {
        if (!payload.messages?.length || !hasAttachmentCandidates(payload.messages)) return;

        const origins = await resolveMaybeLazy(input.ownOrigins);
        const resolvers = createFileServiceResolvers(input, origins);
        await inlineOwnOriginAttachments(payload.messages, resolvers.resolveByUrl, origins, {
          imageMaxBytes,
          imageMaxCount,
          loadArtifact: resolvers.loadArtifact,
          loadRender: resolvers.loadRender,
          resolveByFileId: resolvers.resolveByFileId,
          tools,
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
