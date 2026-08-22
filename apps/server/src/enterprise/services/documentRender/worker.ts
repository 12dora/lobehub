import debug from 'debug';
import { eq } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import { PlatformJobModel } from '@/database/models/platform/job';
import { type FileItem, files } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import type { PlatformJobDispatchHandlerContext } from '@/server/enterprise/jobs/platformJobsDispatcher';
import { isModuleEnabled } from '@/server/enterprise/services/moduleSettings';
import type { PdfPageImage } from '@/server/modules/ModelRuntime/pdfPageImages';
import { renderPdfPagesToPng } from '@/server/modules/ModelRuntime/pdfPageImages';
import { createFileS3 } from '@/server/modules/S3';
import type {
  DocumentRenderEngine,
  DocumentRenderStatus,
  FileRenderMetadata,
  FileRenderPageMeta,
} from '@/types/files';
import { documentRenderArtifactKeys, readFileRenderMetadata } from '@/types/files';

import type { EffectiveDocumentRenderSettings } from '../documentRenderSettings';
import {
  getEffectiveDocumentRenderSettings,
  isDocumentRenderConfigured,
} from '../documentRenderSettings';
import {
  composeContactSheet,
  uploadImageArtifact,
  uploadPdfArtifact,
  uploadPngArtifact,
} from './artifacts';
import type { ClassifyDocumentResult, DocumentRenderKind } from './classify';
import { classifyDocument, isRenderableDocumentKind, resolveDocumentKind } from './classify';
import { extractOoxmlFigures } from './figures';
import { convertToPdf } from './gotenbergClient';
import { clearDocumentRenderTempDir } from './queue';

const log = debug('lobe-server:document-render');

const DENSE_PAGE_CHARS = 1200;
const MAX_BYTES_PER_IMAGE = 20 * 1024 * 1024;
const SIDECAR_UNAVAILABLE = 'sidecar unavailable';

let tempCleared = false;
let activeJobs = 0;
const jobWaiters: Array<() => void> = [];

const withJobConcurrency = async <T>(limit: number, task: () => Promise<T>): Promise<T> => {
  const cap = Math.max(1, Math.floor(limit));
  await new Promise<void>((resolve) => {
    if (activeJobs < cap) {
      activeJobs += 1;
      resolve();
      return;
    }
    jobWaiters.push(() => {
      activeJobs += 1;
      resolve();
    });
  });
  try {
    return await task();
  } finally {
    activeJobs -= 1;
    const next = jobWaiters.shift();
    if (next) next();
  }
};

const ensureTempClearedOnce = async (): Promise<void> => {
  if (tempCleared) return;
  tempCleared = true;
  await clearDocumentRenderTempDir().catch((error) => {
    console.error('Failed to clear document-render temp dir', error);
  });
};

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const asMetadataRecord = (metadata: FileItem['metadata']): Record<string, unknown> =>
  metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};

const patchRenderMetadata = async (
  db: LobeChatDatabase,
  file: FileItem,
  patch: Partial<FileRenderMetadata> & Pick<FileRenderMetadata, 'status'>,
): Promise<FileRenderMetadata> => {
  const prev = readFileRenderMetadata(file.metadata) ?? { status: patch.status };
  const next: FileRenderMetadata = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await db
    .update(files)
    .set({
      metadata: { ...asMetadataRecord(file.metadata), render: next },
      updatedAt: new Date(),
    })
    .where(eq(files.id, file.id));
  file.metadata = { ...asMetadataRecord(file.metadata), render: next };
  return next;
};

const assertNotAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('document render timed out');
};

const uploadFigures = async (
  fileId: string,
  kind: DocumentRenderKind,
  bytes: Uint8Array,
): Promise<FileRenderMetadata['figures']> => {
  if (kind === 'pdf' || kind === 'other') return [];
  const extracted = await extractOoxmlFigures(bytes, kind);
  const figures = [];
  for (const [index, figure] of extracted.entries()) {
    const key = documentRenderArtifactKeys.figure(fileId, figure.page, index + 1, figure.ext);
    await uploadImageArtifact(key, figure.bytes, figure.mimeType);
    figures.push({ key, mimeType: figure.mimeType, page: figure.page });
  }
  return figures;
};

interface RasterizeResult {
  contactSheets: NonNullable<FileRenderMetadata['contactSheets']>;
  failedPages: number;
  pages: Record<string, FileRenderPageMeta>;
  renderedPages: number[];
  truncated: boolean;
}

const rasterizePdf = async (params: {
  fileId: string;
  jobs: PlatformJobModel;
  jobId: string;
  leaseMs: number;
  pdfBytes: Uint8Array;
  settings: EffectiveDocumentRenderSettings;
  signal: AbortSignal;
  visualPages: Array<{ chars: number; page: number }>;
  workerId: string;
}): Promise<RasterizeResult> => {
  const { fileId, settings, visualPages } = params;
  const capped = visualPages.slice(0, settings.maxPages);
  const truncated = visualPages.length > settings.maxPages;
  const pages: Record<string, FileRenderPageMeta> = {};
  for (const visual of visualPages) {
    pages[String(visual.page)] = {
      chars: visual.chars,
      visual: true,
    };
  }
  const thumbs: Array<{ page: number; png: Uint8Array }> = [];
  const renderedPages: number[] = [];
  const densePages = settings.tilesForDensePages
    ? capped.filter((page) => page.chars > DENSE_PAGE_CHARS).map((page) => page.page)
    : [];

  let progress = 0;
  const onPage = async (image: PdfPageImage) => {
    assertNotAborted(params.signal);
    if (image.kind === 'page') {
      const key = documentRenderArtifactKeys.page(fileId, image.page);
      await uploadPngArtifact(key, image.png);
      const meta = pages[String(image.page)] ?? { chars: 0, visual: true };
      meta.png = key;
      if (image.thumb && image.thumb.byteLength > 0) {
        const thumbKey = documentRenderArtifactKeys.thumb(fileId, image.page);
        await uploadPngArtifact(thumbKey, image.thumb);
        meta.thumb = thumbKey;
        thumbs.push({ page: image.page, png: image.thumb });
      }
      pages[String(image.page)] = meta;
      renderedPages.push(image.page);
      progress += 1;
      await params.jobs.checkpoint({
        cursor: { page: image.page },
        jobId: params.jobId,
        leaseMs: params.leaseMs,
        progressDone: progress,
        progressTotal: capped.length,
        workerId: params.workerId,
      });
      return;
    }
    if (image.kind === 'tile' && image.tile) {
      const key = documentRenderArtifactKeys.tile(
        fileId,
        image.page,
        image.tile.row,
        image.tile.col,
      );
      await uploadPngArtifact(key, image.png);
      const meta = pages[String(image.page)] ?? { chars: 0, visual: true };
      meta.tiles = [...(meta.tiles ?? []), key];
      pages[String(image.page)] = meta;
    }
  };

  await renderPdfPagesToPng(params.pdfBytes, {
    maxBytesPerImage: MAX_BYTES_PER_IMAGE,
    maxLongEdgePx: settings.longEdgePx,
    maxPages: settings.maxPages,
    onPage,
    pages: capped.map((page) => page.page),
    retainResults: false,
    thumbLongEdgePx: settings.thumbEdgePx,
    tiles:
      densePages.length > 0
        ? { grid: 2, maxLongEdgePx: settings.longEdgePx, pages: densePages }
        : undefined,
  });

  const failedPages = capped.filter((page) => !pages[String(page.page)]?.png).length;

  const contactSheets: NonNullable<FileRenderMetadata['contactSheets']> = [];
  const sheetSize = settings.contactSheetCols * settings.contactSheetRows;
  for (let index = 0; index < thumbs.length; index += sheetSize) {
    const chunk = thumbs.slice(index, index + sheetSize);
    const sheet = await composeContactSheet({
      cols: settings.contactSheetCols,
      rows: settings.contactSheetRows,
      thumbs: chunk,
    });
    if (!sheet) continue;
    const key = documentRenderArtifactKeys.contactSheet(fileId, contactSheets.length);
    await uploadPngArtifact(key, sheet.png);
    contactSheets.push({ key, pages: sheet.pages });
  }

  return { contactSheets, failedPages, pages, renderedPages, truncated };
};

const runRender = async (params: {
  db: LobeChatDatabase;
  file: FileItem;
  jobId: string;
  jobs: PlatformJobModel;
  leaseMs: number;
  settings: EffectiveDocumentRenderSettings;
  signal: AbortSignal;
  workerId: string;
}): Promise<{ durationMs: number; pages: number | null; status: DocumentRenderStatus }> => {
  const started = Date.now();
  const { db, file, settings } = params;
  const kind = resolveDocumentKind(file.name, file.fileType);

  if (!isRenderableDocumentKind(kind)) {
    await patchRenderMetadata(db, file, { status: 'skipped', tier: 'T0' });
    return { durationMs: Date.now() - started, pages: null, status: 'skipped' };
  }

  if (file.size > settings.maxFileBytes) {
    await patchRenderMetadata(db, file, {
      error: `file exceeds maxFileBytes (${settings.maxFileBytes})`,
      status: 'skipped',
    });
    return { durationMs: Date.now() - started, pages: null, status: 'skipped' };
  }

  const s3 = await createFileS3();
  const bytes = await s3.getFileByteArray(file.url);
  assertNotAborted(params.signal);

  const classified = await classifyDocument(
    { bytes, fileType: file.fileType, name: file.name },
    { mediaThresholdT2: settings.mediaThresholdT2, pptxAlwaysT2: settings.pptxAlwaysT2 },
  );
  await patchRenderMetadata(db, file, {
    jobId: params.jobId,
    status: 'pending',
    tier: classified.tier,
  });

  if (classified.tier === 'T0') {
    await patchRenderMetadata(db, file, {
      engine: classified.kind === 'pdf' ? 'pdfjs' : 'ooxml',
      hasTextLayer: true,
      pageCount: classified.pageCount,
      status: 'skipped',
      tier: 'T0',
    });
    return {
      durationMs: Date.now() - started,
      pages: classified.pageCount ?? 0,
      status: 'skipped',
    };
  }

  if (classified.tier === 'T1') {
    const figures = await uploadFigures(file.id, classified.kind, bytes);
    await patchRenderMetadata(db, file, {
      engine: 'ooxml',
      figures,
      hasTextLayer: true,
      status: 'ready',
      tier: 'T1',
    });
    return { durationMs: Date.now() - started, pages: figures?.length ?? 0, status: 'ready' };
  }

  return runTier2({ ...params, bytes, classified, kind, started });
};

const runTier2 = async (params: {
  bytes: Uint8Array;
  classified: ClassifyDocumentResult;
  db: LobeChatDatabase;
  file: FileItem;
  jobId: string;
  jobs: PlatformJobModel;
  kind: DocumentRenderKind;
  leaseMs: number;
  settings: EffectiveDocumentRenderSettings;
  signal: AbortSignal;
  started: number;
  workerId: string;
}): Promise<{ durationMs: number; pages: number | null; status: DocumentRenderStatus }> => {
  const { bytes, classified, db, file, kind, settings } = params;
  const moduleOn = await isModuleEnabled('documentRender');
  const sidecarOk = moduleOn && isDocumentRenderConfigured(settings);

  let pdfBytes = bytes;
  let engine: DocumentRenderEngine = 'pdfjs';

  if (kind !== 'pdf') {
    if (!sidecarOk || !settings.endpoint) {
      const figures = await uploadFigures(file.id, kind, bytes);
      await patchRenderMetadata(db, file, {
        engine: 'ooxml',
        error: SIDECAR_UNAVAILABLE,
        figures,
        hasTextLayer: true,
        status: 'partial',
        tier: 'T2',
      });
      return {
        durationMs: Date.now() - params.started,
        pages: figures?.length ?? 0,
        status: 'partial',
      };
    }
    assertNotAborted(params.signal);
    pdfBytes = await convertToPdf(settings.endpoint, {
      bytes,
      filename: file.name,
      timeoutMs: settings.timeoutSec * 1000,
    });
    await uploadPdfArtifact(file.id, pdfBytes);
    engine = 'gotenberg';
  }

  const pdfClassified =
    kind === 'pdf'
      ? classified
      : await classifyDocument(
          { bytes: pdfBytes, fileType: 'application/pdf', name: `${file.name}.pdf` },
          settings,
        );
  // Slides carry layout even when text-only, so a deck renders every page;
  // docx/xlsx/pdf render only pages that actually have visual content.
  const everyPageVisual = kind === 'pptx';
  const visualPages = (pdfClassified.pages ?? [])
    .filter((page) => everyPageVisual || page.visual)
    .map((page) => ({ chars: page.chars, page: page.page }));
  const allPages = pdfClassified.pages ?? [];
  const pageMeta: Record<string, FileRenderPageMeta> = {};
  for (const page of allPages) {
    pageMeta[String(page.page)] = {
      chars: page.chars,
      visual: everyPageVisual || page.visual,
    };
  }

  const raster = await rasterizePdf({
    fileId: file.id,
    jobId: params.jobId,
    jobs: params.jobs,
    leaseMs: params.leaseMs,
    pdfBytes,
    settings,
    signal: params.signal,
    visualPages:
      visualPages.length > 0
        ? visualPages
        : allPages.map((page) => ({ chars: page.chars, page: page.page })),
    workerId: params.workerId,
  });

  const pages = { ...pageMeta, ...raster.pages };
  const hasTextLayer = allPages.some((page) => page.chars >= 20);
  const partial = raster.failedPages > 0 || raster.truncated;
  const status: DocumentRenderStatus = partial ? 'partial' : 'ready';

  await patchRenderMetadata(db, file, {
    contactSheets: raster.contactSheets,
    engine,
    error: raster.truncated
      ? 'maxPages truncated'
      : raster.failedPages > 0
        ? 'some pages failed'
        : null,
    hasTextLayer,
    pageCount: pdfClassified.pageCount ?? allPages.length,
    pages,
    renderedPages: raster.renderedPages,
    status,
    tier: 'T2',
  });

  return {
    durationMs: Date.now() - params.started,
    pages: raster.renderedPages.length,
    status,
  };
};

export const processClaimedDocumentRenderJob = async (
  ctx: PlatformJobDispatchHandlerContext,
): Promise<void> => {
  await ensureTempClearedOnce();
  const settings = await getEffectiveDocumentRenderSettings({ db: ctx.db });
  await withJobConcurrency(settings.concurrency, () =>
    processClaimedDocumentRenderJobInner(ctx, settings),
  );
};

const processClaimedDocumentRenderJobInner = async (
  ctx: PlatformJobDispatchHandlerContext,
  settings: EffectiveDocumentRenderSettings,
): Promise<void> => {
  const jobs = new PlatformJobModel(ctx.db);
  const fileId = typeof ctx.job.input?.fileId === 'string' ? ctx.job.input.fileId : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutSec * 1000);

  try {
    if (!fileId) {
      await jobs.fail({
        error: { message: 'missing fileId' },
        jobId: ctx.job.id,
        terminal: true,
        workerId: ctx.workerId,
      });
      return;
    }

    const file = await FileModel.getFileById(ctx.db, fileId);
    if (!file) {
      await jobs.complete({
        jobId: ctx.job.id,
        resultSummary: { status: 'skipped' },
        workerId: ctx.workerId,
      });
      return;
    }

    try {
      const result = await runRender({
        db: ctx.db,
        file,
        jobId: ctx.job.id,
        jobs,
        leaseMs: ctx.spec.leaseMs,
        settings,
        signal: controller.signal,
        workerId: ctx.workerId,
      });
      await patchRenderMetadata(ctx.db, file, {
        durationMs: result.durationMs,
        status: (readFileRenderMetadata(file.metadata)?.status ??
          result.status) as DocumentRenderStatus,
      });
      await jobs.complete({
        jobId: ctx.job.id,
        resultSummary: {
          durationMs: result.durationMs,
          ext: extOf(file.name),
          fileId: file.id,
          pages: result.pages,
          status: result.status,
        },
        workerId: ctx.workerId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('document render failed fileId=%s: %s', fileId, message);
      console.error('document render failed', error);
      await patchRenderMetadata(ctx.db, file, { error: message, status: 'failed' });
      await jobs.fail({
        error: { message },
        jobId: ctx.job.id,
        workerId: ctx.workerId,
      });
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
};
