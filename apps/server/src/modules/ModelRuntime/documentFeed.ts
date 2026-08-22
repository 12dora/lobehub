import type { OpenAIChatMessage } from '@lobechat/model-runtime';
import { isFileUrlPart } from '@lobechat/model-runtime';
import type { FileRenderMetadata, FileRenderPageMeta, FileRenderTextIndex } from '@lobechat/types';
import { DOCUMENT_RENDER_DEFAULTS } from '@lobechat/types';

const FILE_PROXY_PATH = /^\/f\/([^/]+)$/;
const FILE_ID_IN_ATTR_RE = /[\w-]{6,128}/;
const PDF_MIME = 'application/pdf';
const filesInfoBlockRe = () => /<files_info>([\s\S]*?)<\/files_info>/g;

export interface DocumentFeedFileRef {
  fileId: string;
  mimeType?: string;
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
  /** File ids that contributed at least one stored image — skip live rasterization. */
  fedFileIds: string[];
  images: DocumentFeedImage[];
  notices: string[];
}

export interface SelectDocumentFeedInput {
  files: readonly DocumentFeedFileRef[];
  imageMaxCount?: number;
  loadRender: (fileId: string) => Promise<FileRenderMetadata | undefined>;
  loadTextIndex?: (fileId: string, key: string) => Promise<FileRenderTextIndex | undefined>;
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

const collectFromFilesInfo = (
  text: string,
  add: (fileId: string, name?: string, mimeType?: string) => void,
) => {
  if (!text.includes('<files_info>')) return;

  const fileIdRe = new RegExp(`\\bid="(${FILE_ID_IN_ATTR_RE.source})"`);
  for (const block of text.matchAll(filesInfoBlockRe())) {
    const inner = block[1] ?? '';
    for (const tag of inner.matchAll(/<file\b([^>]*)>/gi)) {
      const attrs = tag[1] ?? '';
      const fileId = fileIdRe.exec(attrs)?.[1];
      if (!fileId) continue;
      const name = /\bname="([^"]*)"/.exec(attrs)?.[1];
      const mimeType = /\btype="([^"]*)"/.exec(attrs)?.[1];
      add(fileId, name, mimeType);
    }
  }
};

const normalizeMime = (mimeType: string | undefined): string =>
  mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';

const isPdfFileRef = (file: DocumentFeedFileRef): boolean =>
  normalizeMime(file.mimeType) === PDF_MIME || /\.pdf$/i.test(file.name);

/** Attached file ids on a user message: `file_url` parts + `<files_info>` `<file id>` tags. */
export const collectAttachedDocumentFiles = (message: OpenAIChatMessage): DocumentFeedFileRef[] => {
  const found: DocumentFeedFileRef[] = [];
  const seen = new Set<string>();

  const add = (fileId: string, name?: string, mimeType?: string) => {
    if (!fileId || seen.has(fileId)) return;
    seen.add(fileId);
    found.push({
      fileId,
      name: name || fileId,
      ...(mimeType ? { mimeType } : {}),
    });
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
    if (fileId) add(fileId, part.file_url.name, part.file_url.mimeType);
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

  for (const match of text.matchAll(/\b(?:pages?|slides?|pp)\.?\s*(\d+)(?:\s*[-–—~]\s*(\d+))?/gi)) {
    addRange(pages, Number(match[1]), match[2] ? Number(match[2]) : undefined);
  }
  for (const match of text.matchAll(/\bp\.\s*(\d+)(?:\s*[-–—~]\s*(\d+))?/gi)) {
    addRange(pages, Number(match[1]), match[2] ? Number(match[2]) : undefined);
  }
  for (const match of text.matchAll(/第\s*(\d+)\s*(?:[-–—~]\s*(\d+)\s*)?页/g)) {
    addRange(pages, Number(match[1]), match[2] ? Number(match[2]) : undefined);
  }
  for (const match of text.matchAll(/幻灯片\s*(\d+)(?:\s*[-–—~]\s*(\d+))?/g)) {
    addRange(pages, Number(match[1]), match[2] ? Number(match[2]) : undefined);
  }

  return [...pages].sort((a, b) => a - b);
};

const pageMeta = (render: FileRenderMetadata, page: number): FileRenderPageMeta | undefined =>
  render.pages?.[String(page)];

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

type PageSelectionReason = 'mentioned' | 'relevance' | 'visual' | 'first';

const CJK_CHAR_RE = /[\u3400-\u9FFF]/;
const EXTRA_OCCURRENCE_CAP = 4;

const stripFilesInfoBlocks = (text: string): string =>
  text.replaceAll(/<files_info>[\s\S]*?<\/files_info>/gi, ' ');

const isCjkChar = (ch: string): boolean => CJK_CHAR_RE.test(ch);

const tokenizeQuery = (userText: string): string[] => {
  const stripped = stripFilesInfoBlocks(userText).toLowerCase();
  const tokens = new Set<string>();

  for (const match of stripped.matchAll(/[a-z]{3,}/g)) {
    tokens.add(match[0]!);
  }
  for (const match of stripped.matchAll(/\d{2,}/g)) {
    tokens.add(match[0]!);
  }

  let run = '';
  const flushCjk = () => {
    if (run.length < 2) {
      run = '';
      return;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
    run = '';
  };
  for (const ch of stripped) {
    if (isCjkChar(ch)) {
      run += ch;
    } else {
      flushCjk();
    }
  }
  flushCjk();

  return [...tokens];
};

const countTokenOccurrences = (haystack: string, token: string): number => {
  if (!token) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length - token.length) {
    const at = haystack.indexOf(token, from);
    if (at < 0) break;
    count += 1;
    from = at + 1;
  }
  return count;
};

const scorePageText = (pageText: string, tokens: readonly string[]): number => {
  const haystack = pageText.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    const count = countTokenOccurrences(haystack, token);
    if (count === 0) continue;
    const extras = Math.min(count - 1, EXTRA_OCCURRENCE_CAP);
    score += 1 + 0.5 * extras;
  }
  return score;
};

/**
 * Rank candidate pages by how many distinct query tokens appear in the page
 * excerpt. Extra occurrences add 0.5 each (capped). Ties break toward the
 * lower page number. Returns [] when the query has fewer than 2 tokens.
 */
export const rankPagesByRelevance = (
  textIndex: FileRenderTextIndex,
  userText: string,
  candidates: readonly number[],
): number[] => {
  const tokens = tokenizeQuery(userText);
  if (tokens.length < 2) return [];

  const scored: Array<{ page: number; score: number }> = [];
  for (const page of candidates) {
    const pageText = textIndex[String(page)];
    if (!pageText) continue;
    const score = scorePageText(pageText, tokens);
    if (score <= 0) continue;
    scored.push({ page, score });
  }

  scored.sort((a, b) => b.score - a.score || a.page - b.page);
  return scored.map((entry) => entry.page);
};

const contactSheetLabel = (count: number): string =>
  count === 1 ? '1 contact sheet' : `${count} contact sheets`;

const fullPagesClause = (
  pages: readonly number[],
  selectionReason: PageSelectionReason,
): string => {
  if (pages.length === 0) return '';
  const list = formatPageList(pages);
  const base = pages.length === 1 ? `full page ${list}` : `full pages ${list}`;
  return selectionReason === 'relevance' ? `${base} (matched your question)` : base;
};

const buildReadyNotice = (input: {
  attachedPages: readonly number[];
  contactSheetCount: number;
  name: string;
  pageCount: number;
  render: FileRenderMetadata;
  selectionReason: PageSelectionReason;
  tools: boolean;
}): string => {
  const textLayer = resolveHasTextLayer(input.render) ? 'yes' : 'no';
  const attachedBits = [contactSheetLabel(input.contactSheetCount)];
  const pagesClause = fullPagesClause(input.attachedPages, input.selectionReason);
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
  textIndex: FileRenderTextIndex | undefined,
  userText: string,
  remaining: number,
): { pages: number[]; reason: PageSelectionReason } => {
  const available = new Set(pngPages(render));
  const mentionedAvailable = mentioned.filter((page) => available.has(page));
  if (mentionedAvailable.length > 0) return { pages: mentionedAvailable, reason: 'mentioned' };

  if (textIndex && remaining > 0) {
    const ranked = rankPagesByRelevance(textIndex, userText, [...available]);
    const budget = Math.max(1, remaining);
    const picked = ranked
      .filter((page) => available.has(page) && Boolean(pageMeta(render, page)?.png))
      .slice(0, budget);
    if (picked.length > 0) return { pages: picked, reason: 'relevance' };
  }

  const visual = pngPages(render);
  if (visual.length > 0) return { pages: visual, reason: 'visual' };

  const first = pageMeta(render, 1)?.png ? [1] : [];
  return { pages: first, reason: 'first' };
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

    if (render.status === 'pending') {
      // PDFs without artifacts fall through to live rasterization; do not mark fed.
      if (isPdfFileRef(file)) continue;
      docsUsed += 1;
      notices.push(
        `[Document "${file.name}" page images are still being prepared; text only this turn]`,
      );
      continue;
    }

    if (render.status !== 'ready' && render.status !== 'partial') continue;
    if (remaining <= 0) continue;

    const imagesBefore = images.length;
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

    let textIndex: FileRenderTextIndex | undefined;
    if (mentioned.length === 0 && remaining > 0 && render.textIndex && input.loadTextIndex) {
      try {
        textIndex = await input.loadTextIndex(file.fileId, render.textIndex);
      } catch {
        textIndex = undefined;
      }
    }

    const selected = selectFullPages(render, mentioned, textIndex, input.userText, remaining);
    const attachedPages: number[] = [];
    for (const page of selected.pages) {
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

    if (images.length === imagesBefore) continue;

    docsUsed += 1;
    fedFileIds.push(file.fileId);

    const pageCount =
      render.pageCount ?? Math.max(pngPages(render).at(-1) ?? 0, attachedPages.at(-1) ?? 0);
    notices.push(
      buildReadyNotice({
        attachedPages,
        contactSheetCount: attachedSheets.length,
        name: file.name,
        pageCount,
        render,
        selectionReason: selected.reason,
        tools,
      }),
    );
  }

  return { fedFileIds, images, notices };
};
