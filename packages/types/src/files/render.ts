/**
 * `files.metadata.render` — office/PDF page-render artifacts (no migration; jsonb).
 * See docs/enterprise/office-documents-multimodal-design.md §4.
 */

export const DOCUMENT_RENDER_JOB_TYPE = 'platform.document.render.v1';
/** Daily artifact garbage collection: retention expiry + orphan-prefix scan + totals. */
export const DOCUMENT_RENDER_GC_JOB_TYPE = 'platform.document.render.gc.v1';
/** Per-page text excerpt length stored in the `text/index.json` artifact. */
export const DOCUMENT_RENDER_TEXT_EXCERPT_CHARS = 1500;

export const DOCUMENT_RENDER_TIERS = ['T0', 'T1', 'T2'] as const;
export type DocumentRenderTier = (typeof DOCUMENT_RENDER_TIERS)[number];

export const DOCUMENT_RENDER_STATUSES = [
  'pending',
  'ready',
  'partial',
  'failed',
  'skipped',
] as const;
export type DocumentRenderStatus = (typeof DOCUMENT_RENDER_STATUSES)[number];

export type DocumentRenderEngine = 'gotenberg' | 'ooxml' | 'pdfjs';

export interface FileRenderPageMeta {
  /** Extracted text length of the page (0 = no text layer). */
  chars: number;
  /** Full page PNG (long edge ≤ longEdgePx) object key; absent for non-visual pages. */
  png?: string;
  /** Thumbnail PNG (long edge ≤ thumbEdgePx) object key; absent for non-visual pages. */
  thumb?: string;
  /** 2×2 zoom tile object keys (row-major: tl, tr, bl, br); only for dense pages. */
  tiles?: string[];
  /** Page has images/shapes worth looking at (rendered in T2). */
  visual: boolean;
}

export interface FileRenderFigureMeta {
  caption?: string;
  /** Object key of the extracted original image (T1). */
  key: string;
  mimeType: string;
  page: number;
}

export interface FileRenderContactSheetMeta {
  /** Object key of the contact-sheet PNG. */
  key: string;
  /** Pages included (in grid order, page numbers printed on cells). */
  pages: number[];
}

export interface FileRenderSheetMeta {
  /** 1-based sheet index in workbook order. */
  index: number;
  name: string;
  /** First rendered PDF page of this sheet, when known. */
  page?: number;
}

/**
 * `text/index.json` artifact body: 1-based page number → text excerpt
 * (≤ DOCUMENT_RENDER_TEXT_EXCERPT_CHARS). Used for relevance-ranked page
 * selection at feed time; never fed to the model verbatim.
 */
export type FileRenderTextIndex = Record<string, string>;

export interface FileRenderMetadata {
  /** Contact sheets (thumb grid with page numbers), in page order. */
  contactSheets?: FileRenderContactSheetMeta[];
  /**
   * Artifacts were copied from this file id (same sha256, already rendered)
   * instead of rendering again. Keys still live under this file's own prefix.
   */
  copiedFrom?: string;
  durationMs?: number;
  engine?: DocumentRenderEngine;
  error?: string | null;
  /** T1 extracted original images. */
  figures?: FileRenderFigureMeta[];
  /** Whether the document has a usable text layer (false for scans). */
  hasTextLayer?: boolean;
  jobId?: string;
  pageCount?: number;
  /** Per-page metadata keyed by 1-based page number as string. */
  pages?: Record<string, FileRenderPageMeta>;
  /** Pages with `png` present (T2 visual pages), ascending. */
  renderedPages?: number[];
  /** xlsx workbook sheets (name + first rendered page), workbook order. */
  sheets?: FileRenderSheetMeta[];
  status: DocumentRenderStatus;
  /** Object key of the `text/index.json` page-text excerpt artifact (T2). */
  textIndex?: string;
  tier?: DocumentRenderTier;
  updatedAt?: string;
}

/** Root S3 prefix for all render artifacts of a file. Deleting the file deletes this prefix. */
export const documentRenderArtifactPrefix = (fileId: string): string =>
  `files/render/${fileId}/`;

export const documentRenderArtifactKeys = {
  contactSheet: (fileId: string, index: number) =>
    `${documentRenderArtifactPrefix(fileId)}contact/${index}.png`,
  figure: (fileId: string, page: number, index: number, ext: string) =>
    `${documentRenderArtifactPrefix(fileId)}figures/${page}-${index}.${ext}`,
  page: (fileId: string, page: number) => `${documentRenderArtifactPrefix(fileId)}pages/${page}.png`,
  pdf: (fileId: string) => `${documentRenderArtifactPrefix(fileId)}source.pdf`,
  text: (fileId: string, page: number) => `${documentRenderArtifactPrefix(fileId)}text/${page}.md`,
  textIndex: (fileId: string) => `${documentRenderArtifactPrefix(fileId)}text/index.json`,
  thumb: (fileId: string, page: number) => `${documentRenderArtifactPrefix(fileId)}thumbs/${page}.png`,
  tile: (fileId: string, page: number, row: number, col: number) =>
    `${documentRenderArtifactPrefix(fileId)}tiles/${page}-${row}${col}.png`,
};

export const readFileRenderMetadata = (
  metadata: unknown,
): FileRenderMetadata | undefined => {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const render = (metadata as { render?: unknown }).render;
  if (!render || typeof render !== 'object') return undefined;
  const status = (render as { status?: unknown }).status;
  if (typeof status !== 'string' || !(DOCUMENT_RENDER_STATUSES as readonly string[]).includes(status))
    return undefined;
  return render as FileRenderMetadata;
};
