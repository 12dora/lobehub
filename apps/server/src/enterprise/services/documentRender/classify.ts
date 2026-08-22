import type { PdfPageInspectResult } from '@/server/modules/ModelRuntime/pdfPageImages';
import { inspectPdfPages } from '@/server/modules/ModelRuntime/pdfPageImages';
import type { DocumentRenderTier } from '@/types/files';
import { DOCUMENT_RENDER_DEFAULTS } from '@/types/platform/documentRenderSettings';

import { listZipEntryNames } from './zipEntries';

export type DocumentRenderKind = 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'other';

export interface ClassifyDocumentInput {
  bytes: Uint8Array;
  fileType: string;
  name: string;
}

export interface ClassifyDocumentSettings {
  mediaThresholdT2: number;
  pptxAlwaysT2: boolean;
}

export interface ClassifyDocumentResult {
  kind: DocumentRenderKind;
  mediaCount: number;
  pageCount?: number;
  pages?: PdfPageInspectResult[];
  reason: string;
  tier: DocumentRenderTier;
}

const normalizeZipName = (name: string): string => name.replaceAll('\\', '/').replace(/^\//, '');

export const isRenderableDocumentKind = (kind: DocumentRenderKind): boolean => kind !== 'other';

export const countOoxmlMediaEntries = (names: readonly string[]): number => {
  let count = 0;
  for (const raw of names) {
    const name = normalizeZipName(raw);
    if (name.endsWith('/')) continue;
    const lower = name.toLowerCase();
    const isMedia =
      lower.startsWith('word/media/') ||
      lower.startsWith('ppt/media/') ||
      lower.startsWith('xl/media/') ||
      lower.startsWith('xl/charts/') ||
      lower.includes('/drawings/') ||
      lower.includes('/diagrams/') ||
      lower.startsWith('drawings/') ||
      lower.startsWith('diagrams/');
    if (isMedia) count += 1;
  }
  return count;
};

export const resolveDocumentKind = (name: string, fileType: string): DocumentRenderKind => {
  const lowerName = name.toLowerCase();
  const mime = fileType.toLowerCase();
  if (lowerName.endsWith('.docx') || mime.includes('wordprocessingml.document')) return 'docx';
  if (lowerName.endsWith('.pptx') || mime.includes('presentationml.presentation')) return 'pptx';
  if (lowerName.endsWith('.xlsx') || mime.includes('spreadsheetml.sheet')) return 'xlsx';
  if (lowerName.endsWith('.pdf') || mime === 'application/pdf' || mime === 'application/x-pdf') {
    return 'pdf';
  }
  return 'other';
};

const classifyOoxml = (
  kind: 'docx' | 'pptx' | 'xlsx',
  bytes: Uint8Array,
  settings: ClassifyDocumentSettings,
): ClassifyDocumentResult => {
  const names = listZipEntryNames(bytes);
  const mediaCount = countOoxmlMediaEntries(names);
  const { mediaThresholdT2, pptxAlwaysT2 } = settings;

  if (kind === 'pptx' && pptxAlwaysT2) {
    return {
      kind,
      mediaCount,
      reason: 'pptxAlwaysT2',
      tier: 'T2',
    };
  }

  if (mediaCount >= mediaThresholdT2) {
    return {
      kind,
      mediaCount,
      reason: `mediaCount ${mediaCount} >= threshold ${mediaThresholdT2}`,
      tier: 'T2',
    };
  }

  if (mediaCount > 0) {
    return {
      kind,
      mediaCount,
      reason: `mediaCount ${mediaCount} < threshold ${mediaThresholdT2}`,
      tier: 'T1',
    };
  }

  return { kind, mediaCount: 0, reason: 'no media entries', tier: 'T0' };
};

const classifyPdf = async (bytes: Uint8Array): Promise<ClassifyDocumentResult> => {
  const pages = await inspectPdfPages(bytes);
  if (pages.length === 0) {
    return {
      kind: 'pdf',
      mediaCount: 0,
      pageCount: 0,
      pages,
      reason: 'empty or unreadable pdf',
      tier: 'T0',
    };
  }
  const visualCount = pages.filter((page) => page.visual).length;
  if (visualCount === 0) {
    return {
      kind: 'pdf',
      mediaCount: 0,
      pageCount: pages.length,
      pages,
      reason: 'all pages have text and no images',
      tier: 'T0',
    };
  }
  return {
    kind: 'pdf',
    mediaCount: visualCount,
    pageCount: pages.length,
    pages,
    reason: `${visualCount} visual page(s)`,
    tier: 'T2',
  };
};

export const classifyDocument = async (
  input: ClassifyDocumentInput,
  settings: ClassifyDocumentSettings = DOCUMENT_RENDER_DEFAULTS,
): Promise<ClassifyDocumentResult> => {
  const kind = resolveDocumentKind(input.name, input.fileType);
  if (kind === 'other') {
    return { kind, mediaCount: 0, reason: 'unsupported type', tier: 'T0' };
  }
  if (kind === 'pdf') return classifyPdf(input.bytes);
  return classifyOoxml(kind, input.bytes, settings);
};
