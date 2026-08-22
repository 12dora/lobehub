import type { Canvas, SKRSContext2D } from '@napi-rs/canvas';
import debug from 'debug';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const log = debug('lobe-server:pdf-page-images');

const DEFAULT_MAX_LONG_EDGE_PX = 1800;
const RETRY_SCALE = 0.7;
const PNG_MIME = 'image/png';
const PDF_RENDER_CONCURRENCY = 2;

let activePdfRenders = 0;
const pdfRenderWaiters: Array<() => void> = [];

const acquirePdfRenderSlot = (): Promise<void> =>
  new Promise((resolve) => {
    if (activePdfRenders < PDF_RENDER_CONCURRENCY) {
      activePdfRenders += 1;
      resolve();
      return;
    }
    pdfRenderWaiters.push(() => {
      activePdfRenders += 1;
      resolve();
    });
  });

const releasePdfRenderSlot = (): void => {
  activePdfRenders -= 1;
  const next = pdfRenderWaiters.shift();
  if (next) next();
};

/**
 * Process-wide semaphore: at most two `renderPdfPagesToPng` calls run at once.
 * Exported so tests can drive it with fake renders without loading pdfjs.
 */
export const withPdfRenderSemaphore = async <T>(task: () => Promise<T>): Promise<T> => {
  await acquirePdfRenderSlot();
  try {
    return await task();
  } finally {
    releasePdfRenderSlot();
  }
};

export interface PdfPageImage {
  height: number;
  kind: 'page' | 'tile';
  page: number;
  png: Uint8Array;
  thumb?: Uint8Array;
  thumbHeight?: number;
  thumbWidth?: number;
  tile?: { col: number; row: number };
  width: number;
}

export interface RenderPdfPagesToPngOptions {
  maxBytesPerImage: number;
  maxLongEdgePx: number;
  maxPages: number;
  /** Called as each image is produced so callers can upload and drop the buffer. */
  onPage?: (image: PdfPageImage) => void | Promise<void>;
  /** 1-based page numbers to render. Defaults to `1..min(maxPages, pageCount)`. */
  pages?: number[];
  /**
   * When false, skip accumulating PNG buffers in the returned array (use with `onPage`).
   * Defaults to true so existing callers keep receiving the full result list.
   */
  retainResults?: boolean;
  /** When set, page images also include a downscaled thumbnail PNG. */
  thumbLongEdgePx?: number;
  tiles?: { grid: 2; maxLongEdgePx: number; pages?: number[] };
}

export interface PdfPageInspectResult {
  chars: number;
  page: number;
  visual: boolean;
}

/** Pages with fewer than this many extracted characters are treated as visual (scans). */
export const PDF_VISUAL_CHAR_THRESHOLD = 20;

interface CanvasAndContext {
  canvas: Canvas | null;
  context: SKRSContext2D | null;
}

/**
 * pdfjs `CanvasFactory` backed by `@napi-rs/canvas`.
 * Constructor accepts the `{ enableHWA, ownerDocument }` bag pdfjs passes.
 */
interface NapiCanvasModule {
  createCanvas: (width: number, height: number) => Canvas;
  DOMMatrix: unknown;
  DOMPoint: unknown;
  DOMRect: unknown;
  Path2D: unknown;
}

/**
 * `@napi-rs/canvas` is a native addon: load it lazily (first PDF render) so a
 * missing/misresolved binding degrades this feature instead of crashing server boot.
 */
let canvasModule: NapiCanvasModule | undefined;

class NapiCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    if (!canvasModule) throw new Error('@napi-rs/canvas not loaded');
    const canvas = canvasModule.createCanvas(
      Math.max(1, Math.ceil(width)),
      Math.max(1, Math.ceil(height)),
    );
    const context = canvas.getContext('2d');
    return { canvas, context };
  }

  destroy(canvasAndContext: CanvasAndContext): void {
    if (canvasAndContext.canvas) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
    }
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }

  reset(canvasAndContext: CanvasAndContext, width: number, height: number): void {
    if (!canvasAndContext.canvas) return;
    canvasAndContext.canvas.width = Math.max(1, Math.ceil(width));
    canvasAndContext.canvas.height = Math.max(1, Math.ceil(height));
  }
}

interface PdfJsOps {
  paintImageMaskXObject: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintJpegXObject?: number;
}

interface PdfJsLoaded {
  getDocument: typeof getDocument;
  OPS: PdfJsOps;
}

let pdfjsLoader: Promise<PdfJsLoaded> | undefined;

const installDomPolyfills = (mod: NapiCanvasModule): void => {
  // napi-rs types are structurally close to the DOM lib but not assignable.
  if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
    const { DOMMatrix, DOMPoint, DOMRect, Path2D } = mod;
    Object.assign(globalThis, { DOMMatrix, DOMPoint, DOMRect, Path2D });
  }
};

const loadPdfJs = (): Promise<PdfJsLoaded> => {
  pdfjsLoader ??= (async () => {
    canvasModule = await import('@napi-rs/canvas');
    installDomPolyfills(canvasModule);
    // Side-effect import, same pattern as packages/file-loaders PdfLoader.
    // @ts-expect-error pdfjs worker ships without declaration files
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  })();
  return pdfjsLoader;
};

const collectImageOperatorIds = (OPS: PdfJsOps): Set<number> => {
  const ids = new Set<number>([
    OPS.paintImageMaskXObject,
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
  ]);
  const jpeg = (OPS as { paintJpegXObject?: number }).paintJpegXObject;
  if (typeof jpeg === 'number') ids.add(jpeg);
  return ids;
};

const countTextChars = (items: Array<{ str?: unknown }>): number => {
  let chars = 0;
  for (const item of items) {
    if (typeof item.str === 'string') chars += item.str.length;
  }
  return chars;
};

/**
 * Per-page text length + visual-content flag (image XObjects or almost no text).
 * Used by document-render classification. Failures skip the page rather than throw.
 */
export const inspectPdfPages = async (bytes: Uint8Array): Promise<PdfPageInspectResult[]> => {
  if (bytes.byteLength === 0) return [];

  let pdf: PDFDocumentProxy | undefined;
  try {
    const { getDocument, OPS } = await loadPdfJs();
    const imageOps = collectImageOperatorIds(OPS);
    const data = new Uint8Array(bytes.byteLength);
    data.set(bytes);

    const loadingTask = getDocument({
      CanvasFactory: NapiCanvasFactory,
      data,
      useSystemFonts: true,
    });
    pdf = await loadingTask.promise;

    const results: PdfPageInspectResult[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      let page: PDFPageProxy | undefined;
      try {
        page = await pdf.getPage(pageNumber);
        const text = await page.getTextContent();
        const chars = countTextChars(text.items as Array<{ str?: unknown }>);
        const operators = await page.getOperatorList();
        const hasImage = operators.fnArray.some((fn) => imageOps.has(fn));
        results.push({
          chars,
          page: pageNumber,
          visual: chars < PDF_VISUAL_CHAR_THRESHOLD || hasImage,
        });
      } catch (error) {
        log(
          'failed to inspect PDF page %d: %s',
          pageNumber,
          error instanceof Error ? error.message : error,
        );
        results.push({ chars: 0, page: pageNumber, visual: true });
      } finally {
        page?.cleanup();
      }
    }
    return results;
  } catch (error) {
    log('failed to inspect PDF: %s', error instanceof Error ? error.message : error);
    console.error('failed to inspect PDF', error);
    return [];
  } finally {
    try {
      await pdf?.destroy();
    } catch (error) {
      log('failed to destroy PDF document: %s', error instanceof Error ? error.message : error);
      console.error('failed to destroy PDF document', error);
    }
  }
};

const fitScale = (width: number, height: number, maxLongEdgePx: number): number => {
  const longEdge = Math.max(width, height);
  if (longEdge <= 0 || maxLongEdgePx <= 0) return 1;
  return longEdge > maxLongEdgePx ? maxLongEdgePx / longEdge : 1;
};

const encodePng = (canvas: Canvas): Uint8Array => Uint8Array.from(canvas.toBuffer(PNG_MIME));

const quadrantRects = (width: number, height: number, grid: 2) => {
  const midX = Math.floor(width / grid);
  const midY = Math.floor(height / grid);
  return [
    { col: 0, row: 0, sh: midY, sw: midX, sx: 0, sy: 0 },
    { col: 1, row: 0, sh: midY, sw: width - midX, sx: midX, sy: 0 },
    { col: 0, row: 1, sh: height - midY, sw: midX, sx: 0, sy: midY },
    { col: 1, row: 1, sh: height - midY, sw: width - midX, sx: midX, sy: midY },
  ].filter((rect) => rect.sw > 0 && rect.sh > 0);
};

const renderPageToCanvas = async (
  page: PDFPageProxy,
  scale: number,
  factory: NapiCanvasFactory,
): Promise<CanvasAndContext | undefined> => {
  const viewport = page.getViewport({ scale });
  const canvasAndContext = factory.create(viewport.width, viewport.height);
  const { canvas, context } = canvasAndContext;
  if (!canvas || !context) {
    factory.destroy(canvasAndContext);
    return undefined;
  }

  try {
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    return canvasAndContext;
  } catch (error) {
    factory.destroy(canvasAndContext);
    throw error;
  }
};

const encodeQuadrant = (
  source: Canvas,
  rect: { sh: number; sw: number; sx: number; sy: number },
  maxLongEdgePx: number,
  maxBytesPerImage: number,
  factory: NapiCanvasFactory,
): { height: number; png: Uint8Array; width: number } | undefined => {
  const tryEncode = (scale: number) => {
    const width = Math.max(1, Math.round(rect.sw * scale));
    const height = Math.max(1, Math.round(rect.sh * scale));
    const dest = factory.create(width, height);
    try {
      const { canvas, context } = dest;
      if (!canvas || !context) return undefined;
      context.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, height);
      return { height: canvas.height, png: encodePng(canvas), width: canvas.width };
    } finally {
      factory.destroy(dest);
    }
  };

  const fit = fitScale(rect.sw, rect.sh, maxLongEdgePx);
  let rendered = tryEncode(fit);
  if (rendered && rendered.png.byteLength > maxBytesPerImage) {
    log(
      'tile PNG over cap size=%d max=%d, retrying at %s×',
      rendered.png.byteLength,
      maxBytesPerImage,
      RETRY_SCALE,
    );
    rendered = tryEncode(fit * RETRY_SCALE);
    if (rendered && rendered.png.byteLength > maxBytesPerImage) {
      log(
        'tile PNG still over cap after retry size=%d max=%d, skipping',
        rendered.png.byteLength,
        maxBytesPerImage,
      );
      return undefined;
    }
  }

  return rendered;
};

const renderPageTiles = async (
  page: PDFPageProxy,
  pageNumber: number,
  baseScale: number,
  tiles: { grid: 2; maxLongEdgePx: number },
  maxBytesPerImage: number,
  factory: NapiCanvasFactory,
): Promise<PdfPageImage[]> => {
  const tileMaxLongEdgePx =
    tiles.maxLongEdgePx > 0 ? tiles.maxLongEdgePx : DEFAULT_MAX_LONG_EDGE_PX;
  const canvasAndContext = await renderPageToCanvas(page, baseScale * tiles.grid, factory);
  if (!canvasAndContext?.canvas) return [];

  try {
    const { canvas } = canvasAndContext;
    const results: PdfPageImage[] = [];
    for (const rect of quadrantRects(canvas.width, canvas.height, tiles.grid)) {
      const encoded = encodeQuadrant(canvas, rect, tileMaxLongEdgePx, maxBytesPerImage, factory);
      if (!encoded) continue;
      results.push({
        kind: 'tile',
        page: pageNumber,
        tile: { col: rect.col, row: rect.row },
        ...encoded,
      });
    }
    return results;
  } finally {
    factory.destroy(canvasAndContext);
  }
};

const encodeThumbFromCanvas = (
  source: Canvas,
  thumbLongEdgePx: number,
  factory: NapiCanvasFactory,
): { height: number; png: Uint8Array; width: number } | undefined => {
  const scale = fitScale(source.width, source.height, thumbLongEdgePx);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const dest = factory.create(width, height);
  try {
    const { canvas, context } = dest;
    if (!canvas || !context) return undefined;
    context.drawImage(source, 0, 0, width, height);
    return { height: canvas.height, png: encodePng(canvas), width: canvas.width };
  } finally {
    factory.destroy(dest);
  }
};

const renderPageAtScale = async (
  page: PDFPageProxy,
  scale: number,
  factory: NapiCanvasFactory,
  thumbLongEdgePx?: number,
): Promise<
  | {
      height: number;
      png: Uint8Array;
      thumb?: Uint8Array;
      thumbHeight?: number;
      thumbWidth?: number;
      width: number;
    }
  | undefined
> => {
  const canvasAndContext = await renderPageToCanvas(page, scale, factory);
  if (!canvasAndContext?.canvas) return undefined;
  try {
    const { canvas } = canvasAndContext;
    const thumb =
      thumbLongEdgePx && thumbLongEdgePx > 0
        ? encodeThumbFromCanvas(canvas, thumbLongEdgePx, factory)
        : undefined;
    return {
      height: canvas.height,
      png: encodePng(canvas),
      ...(thumb ? { thumb: thumb.png, thumbHeight: thumb.height, thumbWidth: thumb.width } : {}),
      width: canvas.width,
    };
  } finally {
    factory.destroy(canvasAndContext);
  }
};

/**
 * Rasterize the first `maxPages` of a PDF to PNG. Per-page failures are logged
 * and skipped; document-level failures return an empty array (never throw).
 * Concurrent calls are capped process-wide by `withPdfRenderSemaphore`.
 */
export const renderPdfPagesToPng = async (
  bytes: Uint8Array,
  opts: RenderPdfPagesToPngOptions,
): Promise<PdfPageImage[]> =>
  withPdfRenderSemaphore(() => renderPdfPagesToPngUncapped(bytes, opts));

const renderPdfPagesToPngUncapped = async (
  bytes: Uint8Array,
  opts: RenderPdfPagesToPngOptions,
): Promise<PdfPageImage[]> => {
  const maxPages = Math.max(0, Math.floor(opts.maxPages));
  const maxLongEdgePx = opts.maxLongEdgePx > 0 ? opts.maxLongEdgePx : DEFAULT_MAX_LONG_EDGE_PX;
  const { maxBytesPerImage } = opts;
  const retainResults = opts.retainResults !== false;
  if (maxPages === 0 || bytes.byteLength === 0) return [];

  const factory = new NapiCanvasFactory();
  let pdf: PDFDocumentProxy | undefined;

  try {
    const { getDocument } = await loadPdfJs();
    // Copy: getDocument may transfer the TypedArray to the worker thread.
    const data = new Uint8Array(bytes.byteLength);
    data.set(bytes);

    const loadingTask = getDocument({
      CanvasFactory: NapiCanvasFactory,
      data,
      useSystemFonts: true,
    });
    pdf = await loadingTask.promise;
    const pdfDocument = pdf;
    const requested = opts.pages?.filter((page) => page >= 1 && page <= pdfDocument.numPages);
    const pageNumbers = (
      requested && requested.length > 0
        ? requested
        : Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1)
    ).slice(0, maxPages);

    const results: PdfPageImage[] = [];
    const emit = async (image: PdfPageImage) => {
      if (opts.onPage) await opts.onPage(image);
      if (retainResults) results.push(image);
    };

    for (const pageNumber of pageNumbers) {
      let page: PDFPageProxy | undefined;
      try {
        page = await pdf.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = fitScale(baseViewport.width, baseViewport.height, maxLongEdgePx);
        let rendered = await renderPageAtScale(page, scale, factory, opts.thumbLongEdgePx);

        if (rendered && rendered.png.byteLength > maxBytesPerImage) {
          log(
            'page %d PNG over cap size=%d max=%d, retrying at %s×',
            pageNumber,
            rendered.png.byteLength,
            maxBytesPerImage,
            RETRY_SCALE,
          );
          rendered = await renderPageAtScale(
            page,
            scale * RETRY_SCALE,
            factory,
            opts.thumbLongEdgePx,
          );
          if (rendered && rendered.png.byteLength > maxBytesPerImage) {
            log(
              'page %d PNG still over cap after retry size=%d max=%d, skipping',
              pageNumber,
              rendered.png.byteLength,
              maxBytesPerImage,
            );
            continue;
          }
        }

        if (!rendered) continue;
        await emit({ kind: 'page', page: pageNumber, ...rendered });

        const tilePages = opts.tiles?.pages;
        const shouldTile =
          opts.tiles?.grid === 2 &&
          (!tilePages || tilePages.length === 0 || tilePages.includes(pageNumber));
        if (shouldTile && opts.tiles) {
          try {
            const tiles = await renderPageTiles(
              page,
              pageNumber,
              scale,
              opts.tiles,
              maxBytesPerImage,
              factory,
            );
            for (const tile of tiles) {
              await emit(tile);
            }
          } catch (error) {
            log(
              'failed to tile PDF page %d: %s',
              pageNumber,
              error instanceof Error ? error.message : error,
            );
            console.error('failed to tile PDF page', pageNumber, error);
          }
        }
      } catch (error) {
        log(
          'failed to render PDF page %d: %s',
          pageNumber,
          error instanceof Error ? error.message : error,
        );
        console.error('failed to render PDF page', pageNumber, error);
      } finally {
        page?.cleanup();
      }
    }

    return results;
  } catch (error) {
    log('failed to rasterize PDF: %s', error instanceof Error ? error.message : error);
    console.error('failed to rasterize PDF', error);
    return [];
  } finally {
    try {
      await pdf?.destroy();
    } catch (error) {
      log('failed to destroy PDF document: %s', error instanceof Error ? error.message : error);
      console.error('failed to destroy PDF document', error);
    }
  }
};
