import type { OpenAIChatMessage } from '@lobechat/model-runtime';
import { isFileUrlPart } from '@lobechat/model-runtime';
import type { FileRenderMetadata, FileRenderPageMeta } from '@lobechat/types';
import { DOCUMENT_RENDER_DEFAULTS } from '@lobechat/types';

const FILE_PROXY_PATH = /^\/f\/([^/]+)$/;
const FILE_ID_IN_ATTR_RE = /[\w-]{6,128}/;
const filesInfoBlockRe = () => /<files_info>([\s\S]*?)<\/files_info>/g;

export interface DocumentFeedFileRef {
  fileId: string;
  name: string;
}

export type DocumentFeedImageKind = 'contactSheet' | 'page' | 'tile';

export interface DocumentFeedImage {
  detail: 'high' | 'low';
  fileId: string;
  key: string;
  kind: DocumentFeedImageKind;
  page?: number;
}

export interface DocumentFeedResult {
  /** File ids whose render was consumed (ready/partial/pending) — skip live rasterization. */
  fedFileIds: string[];
  images: DocumentFeedImage[];
  notices: string[];
}

export interface SelectDocumentFeedInput {
  files: readonly DocumentFeedFileRef[];
  imageMaxCount?: number;
  loadRender: (fileId: string) => Promise<FileRenderMetadata | undefined>;
  maxDocsPerRequest?: number;
  tools?: boolean;
  userText: string;
}

const extractFileProxyId = (url: string): string | undefined => {
  try {
    const match = FILE_PROXY_PATH.exec(new URL(url).pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
};

const collectFromFilesInfo = (text: string, add: (fileId: string, name?: string) => void) => {
  if (!text.includes('<files_info>')) return;

  const fileIdRe = new RegExp(`\\bid="(${FILE_ID_IN_ATTR_RE.source})"`);
  for (const block of text.matchAll(filesInfoBlockRe())) {
    const inner = block[1] ?? '';
    for (const tag of inner.matchAll(/<file\b([^>]*)>/gi)) {
      const attrs = tag[1] ?? '';
      const fileId = fileIdRe.exec(attrs)?.[1];
      if (!fileId) continue;
      const name = /\bname="([^"]*)"/.exec(attrs)?.[1];
      add(fileId, name);
    }
  }
};

/** Attached file ids on a user message: `file_url` parts + `<files_info>` `<file id>` tags. */
export const collectAttachedDocumentFiles = (message: OpenAIChatMessage): DocumentFeedFileRef[] => {
  const found: DocumentFeedFileRef[] = [];
  const seen = new Set<string>();

  const add = (fileId: string, name?: string) => {
    if (!fileId || seen.has(fileId)) return;
    seen.add(fileId);
    found.push({ fileId, name: name || fileId });
  };

  const content = message.content;
  if (typeof content === 'string') {
    collectFromFilesInfo(content, add);
    return found;
  }
  if (!Array.isArray(content)) return found;

  for (const part of content) {
    if (part.type === 'text') collectFromFilesInfo(part.text, add);
    if (!isFileUrlPart(part)) continue;
    const fileId = part.file_url.fileId ?? extractFileProxyId(part.file_url.url);
    if (fileId) add(fileId, part.file_url.name);
  }

  return found;
};

export const collectUserText = (message: OpenAIChatMessage): string => {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
};

const addRange = (pages: Set<number>, start: number, end?: number) => {
  const from = Math.min(start, end ?? start);
  const to = Math.max(start, end ?? start);
  for (let page = from; page <= to; page += 1) {
    if (page > 0) pages.add(page);
  }
};

/** Parse "page 3", "第3页", "p.3", "slides 2-4", "幻灯片 2", "pages 2-4". */
export const parseMentionedPages = (text: string): number[] => {
  const pages = new Set<number>();

  for (const match of text.matchAll(
    /\b(?:pages?|slides?|pp)\.?\s*(\d+)(?:\s*[-–—~]\s*(\d+))?/gi,
  )) {
    addRange(pages, Number(match[1]), match[2] ? Number(match[2]) : undefined);
  }
  for (const match of text.matchAll(/\bp\.\s*(\d+)(?:\s*[-–—~]\s*(\d+))?/gi)) {
    addRange(pages, Number(match[1]), match[2] ? Number(match[2]) : undefined);
  }
  for (const match of text.matchAll(/第\s*(\d+)\s*(?:[-–—~]\s*(\d+))?\s*页/g)) {
    addRange(pages, Number(match[1]), match[2] ? Number(match[2]) : undefined);
  }
  for (const match of text.matchAll(/幻灯片\s*(\d+)(?:\s*[-–—~]\s*(\d+))?/g)) {
    addRange(pages, Number(match[1]), match[2] ? Number(match[2]) : undefined);
  }

  return [...pages].sort((a, b) => a - b);
};

const pageMeta = (
  render: FileRenderMetadata,
  page: number,
): FileRenderPageMeta | undefined => render.pages?.[String(page)];

const pngPages = (render: FileRenderMetadata): number[] => {
  if (render.renderedPages?.length) return [...render.renderedPages].sort((a, b) => a - b);

  const fromMeta = Object.entries(render.pages ?? {})
    .filter(([, meta]) => meta.visual && meta.png)
    .map(([key]) => Number(key))
    .filter((page) => Number.isFinite(page) && page > 0)
    .sort((a, b) => a - b);
  return fromMeta;
};

const visualUnattachedPages = (render: FileRenderMetadata, attached: ReadonlySet<number>) =>
  pngPages(render).filter((page) => !attached.has(page));

const resolveHasTextLayer = (render: FileRenderMetadata): boolean => {
  if (typeof render.hasTextLayer === 'boolean') return render.hasTextLayer;
  const pages = Object.values(render.pages ?? {});
  if (pages.length === 0) return true;
  return pages.some((page) => page.chars > 0);
};

const formatPageList = (pages: readonly number[]): string => {
  if (pages.length === 0) return '';
  const sorted = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = start;

  const flush = () => {
    parts.push(start === prev ? String(start) : `${start}…${prev}`);
  };

  for (let index = 1; index < sorted.length; index += 1) {
    const page = sorted[index]!;
    if (page === prev + 1) {
      prev = page;
      continue;
    }
    flush();
    start = page;
    prev = page;
  }
  flush();
  return parts.join(', ');
};

const contactSheetLabel = (count: number): string =>
  count === 1 ? '1 contact sheet' : `${count} contact sheets`;

const fullPagesClause = (pages: readonly number[]): string => {
  if (pages.length === 0) return '';
  const list = formatPageList(pages);
  return pages.length === 1 ? `full page ${list}` : `full pages ${list}`;
};

const buildReadyNotice = (input: {
  attachedPages: readonly number[];
  contactSheetCount: number;
  name: string;
  pageCount: number;
  render: FileRenderMetadata;
  tools: boolean;
}): string => {
  const textLayer = resolveHasTextLayer(input.render) ? 'yes' : 'no';
  const attachedBits = [contactSheetLabel(input.contactSheetCount)];
  const pagesClause = fullPagesClause(input.attachedPages);
  if (pagesClause) attachedBits.push(pagesClause);

  const otherPages = input.tools
    ? 'for other pages call viewDocumentPages or name the page numbers'
    : 'for other pages name the page numbers in your next message';

  let notice = `[Document "${input.name}": ${input.pageCount} pages, text layer: ${textLayer}; attached ${attachedBits.join(' and ')}; ${otherPages}]`;

  const unattached = visualUnattachedPages(input.render, new Set(input.attachedPages));
  if (unattached.length > 0) {
    notice += ` [pages ${formatPageList(unattached)} contain images, not attached]`;
  }

  return notice;
};

const selectFullPages = (
  render: FileRenderMetadata,
  mentioned: readonly number[],
): number[] => {
  const available = new Set(pngPages(render));
  const mentionedAvailable = mentioned.filter((page) => available.has(page));
  if (mentionedAvailable.length > 0) return mentionedAvailable;

  const visual = pngPages(render);
  if (visual.length > 0) return visual;

  const first = pageMeta(render, 1)?.png ? [1] : [];
  return first;
};

export const selectDocumentFeed = async (
  input: SelectDocumentFeedInput,
): Promise<DocumentFeedResult> => {
  const imageMaxCount = input.imageMaxCount ?? DOCUMENT_RENDER_DEFAULTS.maxImagesDefault;
  const maxDocs = input.maxDocsPerRequest ?? DOCUMENT_RENDER_DEFAULTS.maxDocsPerRequest;
  const tools = input.tools ?? true;
  const mentioned = parseMentionedPages(input.userText);

  const images: DocumentFeedImage[] = [];
  const notices: string[] = [];
  const fedFileIds: string[] = [];
  let remaining = imageMaxCount;
  let docsUsed = 0;

  for (const file of input.files) {
    if (docsUsed >= maxDocs) break;

    const render = await input.loadRender(file.fileId);
    if (!render) continue;

    if (render.status === 'skipped' || render.tier === 'T0' || render.status === 'failed') {
      continue;
    }

    docsUsed += 1;
    fedFileIds.push(file.fileId);

    if (render.status === 'pending') {
      notices.push(
        `[Document "${file.name}" page images are still being prepared; text only this turn]`,
      );
      continue;
    }

    if (render.status !== 'ready' && render.status !== 'partial') continue;

    const contactSheets = render.contactSheets ?? [];
    const attachedSheets: DocumentFeedImage[] = [];
    for (const sheet of contactSheets) {
      if (remaining <= 0) break;
      attachedSheets.push({
        detail: 'low',
        fileId: file.fileId,
        key: sheet.key,
        kind: 'contactSheet',
      });
      remaining -= 1;
    }
    images.push(...attachedSheets);

    const wantedPages = selectFullPages(render, mentioned);
    const attachedPages: number[] = [];
    for (const page of wantedPages) {
      if (remaining <= 0) break;
      const meta = pageMeta(render, page);
      const key = meta?.png;
      if (!key) continue;
      images.push({
        detail: 'high',
        fileId: file.fileId,
        key,
        kind: 'page',
        page,
      });
      attachedPages.push(page);
      remaining -= 1;
    }

    if (attachedPages.length === 1 && remaining > 0) {
      const tiles = pageMeta(render, attachedPages[0]!)?.tiles ?? [];
      for (const key of tiles) {
        if (remaining <= 0) break;
        images.push({
          detail: 'high',
          fileId: file.fileId,
          key,
          kind: 'tile',
          page: attachedPages[0],
        });
        remaining -= 1;
      }
    }

    const pageCount = render.pageCount ?? Math.max(pngPages(render).at(-1) ?? 0, attachedPages.at(-1) ?? 0);
    notices.push(
      buildReadyNotice({
        attachedPages,
        contactSheetCount: attachedSheets.length,
        name: file.name,
        pageCount,
        render,
        tools,
      }),
    );
  }

  return { fedFileIds, images, notices };
};
