import type { OpenAIChatMessage, UserMessageContentPart } from '@lobechat/model-runtime';
import { documentRenderArtifactPrefix } from '@lobechat/types';
import debug from 'debug';

import { normalizeMime, toDataUri } from './attachmentInlinerUrls';
import { renderPdfPagesToPng } from './pdfPageImages';

const log = debug('lobe-server:attachment-inliner');

const PDF_MIME = 'application/pdf';
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const; // %PDF
const FILE_ID_IN_ATTR_RE = /[\w-]{6,128}/;
const IMAGE_ONLY_PDF_MIN_TEXT_CHARS = 20;
const IMAGE_ONLY_PDF_MAX_PAGES = 4;
const IMAGE_ONLY_PDF_MAX_LONG_EDGE_PX = 1800;
export const IMAGE_ONLY_PDF_MAX_IMAGES_PER_MESSAGE = 6;
const IMAGE_ONLY_PDF_TILE_GRID = 2 as const;
const PAGE_TAG_RE = /<\/?page\b[^>]*>/gi;

export const filesInfoBlockRe = () => /<files_info>([\s\S]*?)<\/files_info>/g;
export const isArtifactKeyForFile = (key: string, fileId: string): boolean =>
  Boolean(fileId) && key.startsWith(documentRenderArtifactPrefix(fileId));
export const hasPdfMagic = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= PDF_MAGIC.length &&
  bytes[0] === PDF_MAGIC[0] &&
  bytes[1] === PDF_MAGIC[1] &&
  bytes[2] === PDF_MAGIC[2] &&
  bytes[3] === PDF_MAGIC[3];

export const isPdfBytes = (
  declaredMime: string | undefined,
  resolvedMime: string | undefined,
  bytes: Uint8Array,
): boolean =>
  normalizeMime(declaredMime) === PDF_MIME ||
  normalizeMime(resolvedMime) === PDF_MIME ||
  hasPdfMagic(bytes);

export const escapeRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const strippedPdfTextLength = (content: string | undefined): number => {
  if (!content) return 0;
  return content.replaceAll(PAGE_TAG_RE, '').replaceAll(/\s+/g, '').length;
};

export type PdfTextKind = 'empty' | 'sparse' | 'rich';

export const pdfTextKind = (content: string | undefined): PdfTextKind => {
  const length = strippedPdfTextLength(content);
  if (length === 0) return 'empty';
  if (length < IMAGE_ONLY_PDF_MIN_TEXT_CHARS) return 'sparse';
  return 'rich';
};

export const imageOnlyPdfNotice = (
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
export const markImageOnlyPdfInFilesInfo = (text: string, fileId: string): string => {
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

export interface FilesInfoImageOnlyPdf {
  fileId: string;
  name: string;
  textKind: Exclude<PdfTextKind, 'rich'>;
}

/**
 * Image-only PDFs inside `<files_info>` (with or without `sandboxPath` / `url`).
 * Id is `[A-Za-z0-9_-]{6,128}` — FileModel lookup is the real validation
 * (bot/IM uploads use UUID ids from `uploadFromBuffer`).
 */
export const collectImageOnlyPdfsFromFilesInfo = (text: string): FilesInfoImageOnlyPdf[] => {
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

export interface RasterizedPdfImage {
  dataUri: string;
  kind: 'page' | 'tile';
  page: number;
}

export interface RasterizedPdfImages {
  images: RasterizedPdfImage[];
}

export const selectRasterizedImages = (
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

export const rasterizeImageOnlyPdf = async (
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
export const toolMessageText = (message: OpenAIChatMessage): string | undefined => {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const texts = message.content.filter((part) => part.type === 'text').map((part) => part.text);
  return texts.length > 0 ? texts.join('\n') : undefined;
};

export const setToolMessageText = (message: OpenAIChatMessage, text: string) => {
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

export const artifactToDataUri = (
  bytes: Uint8Array | null,
  imageMaxBytes: number,
): string | undefined => {
  if (!bytes?.byteLength || bytes.byteLength > imageMaxBytes) return undefined;
  return toDataUri('image/png', bytes);
};
