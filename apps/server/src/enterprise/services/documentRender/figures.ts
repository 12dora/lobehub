import type { FileRenderFigureMeta } from '@/types/files';

import { extractZipEntries, listZipEntryNames } from './zipEntries';

const MAX_FIGURES = 12;
const MAX_FIGURE_BYTES = 4 * 1024 * 1024;

const IMAGE_EXT_MIME: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const normalizeZipName = (name: string): string => name.replaceAll('\\', '/').replace(/^\//, '');

const extOf = (name: string): string => {
  const base = name.split('/').at(-1) ?? name;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
};

const isMediaImageEntry = (name: string): boolean => {
  const n = normalizeZipName(name);
  if (n.endsWith('/')) return false;
  const inMedia = /^word\/media\//i.test(n) || /^ppt\/media\//i.test(n) || /^xl\/media\//i.test(n);
  if (!inMedia) return false;
  return Boolean(IMAGE_EXT_MIME[extOf(n)]);
};

const parsePptxSlideRels = (xml: string, slideNumber: number, pageByMedia: Map<string, number>) => {
  const targetRe = /Target="([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = targetRe.exec(xml))) {
    const target = normalizeZipName(match[1] ?? '');
    const mediaIndex = target.toLowerCase().lastIndexOf('media/');
    if (mediaIndex < 0) continue;
    const mediaName = target
      .slice(mediaIndex + 'media/'.length)
      .split('/')
      .at(-1);
    if (!mediaName) continue;
    const key = mediaName.toLowerCase();
    if (!pageByMedia.has(key)) pageByMedia.set(key, slideNumber);
  }
};

export interface ExtractedFigure {
  bytes: Uint8Array;
  ext: string;
  mimeType: string;
  page: number;
}

export const extractOoxmlFigures = async (
  bytes: Uint8Array,
  kind: 'docx' | 'pptx' | 'xlsx',
): Promise<ExtractedFigure[]> => {
  const names = listZipEntryNames(bytes).map(normalizeZipName);
  const mediaNames = names.filter((name) => isMediaImageEntry(name)).slice(0, MAX_FIGURES);
  if (mediaNames.length === 0) return [];

  const wanted = new Set(mediaNames);
  const pageByMedia = new Map<string, number>();

  if (kind === 'pptx') {
    const relNames = names.filter((name) =>
      /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/i.test(name),
    );
    for (const rel of relNames) wanted.add(rel);
  }

  const entries = await extractZipEntries(bytes, wanted);
  const byName = new Map(entries.map((entry) => [normalizeZipName(entry.name), entry]));

  if (kind === 'pptx') {
    const decoder = new TextDecoder('utf-8');
    for (const [name, entry] of byName) {
      const slideMatch = /^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/i.exec(name);
      if (!slideMatch) continue;
      parsePptxSlideRels(decoder.decode(entry.bytes), Number(slideMatch[1]), pageByMedia);
    }
  }

  const figures: ExtractedFigure[] = [];
  for (const name of mediaNames) {
    const entry = byName.get(name);
    if (!entry) continue;
    if (entry.bytes.byteLength === 0 || entry.bytes.byteLength > MAX_FIGURE_BYTES) continue;
    const ext = extOf(name);
    const mimeType = IMAGE_EXT_MIME[ext];
    if (!mimeType) continue;
    const fileName = name.split('/').at(-1)?.toLowerCase() ?? '';
    const page = kind === 'pptx' ? (pageByMedia.get(fileName) ?? 1) : 1;
    figures.push({ bytes: entry.bytes, ext: ext === 'jpg' ? 'jpeg' : ext, mimeType, page });
    if (figures.length >= MAX_FIGURES) break;
  }
  return figures;
};

export const toFigureMetas = (
  fileId: string,
  figures: readonly ExtractedFigure[],
  keyFor: (page: number, index: number, ext: string) => string,
): FileRenderFigureMeta[] =>
  figures.map((figure, index) => ({
    key: keyFor(figure.page, index + 1, figure.ext),
    mimeType: figure.mimeType,
    page: figure.page,
  }));
