import debug from 'debug';
import { eq, sql } from 'drizzle-orm';

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
  FileRenderSheetMeta,
  FileRenderTextIndex,
} from '@/types/files';
import { documentRenderArtifactKeys, readFileRenderMetadata } from '@/types/files';

import type { EffectiveDocumentRenderSettings } from '../documentRenderSettings';
import {
  getEffectiveDocumentRenderSettings,
  isDocumentRenderConfigured,
} from '../documentRenderSettings';
import {
  composeContactSheet,
  copyDocumentRenderArtifacts,
  deleteDocumentRenderArtifacts,
  uploadImageArtifact,
  uploadJsonArtifact,
  uploadPdfArtifact,
  uploadPngArtifact,
} from './artifacts';
import type { ClassifyDocumentResult, DocumentRenderKind } from './classify';
import {
  classifyDocument,
  isRenderableDocumentKind,
  parseXlsxWorkbookSheets,
  resolveDocumentKind,
} from './classify';
import { extractOoxmlFigures } from './figures';
import { convertToPdf } from './gotenbergClient';
import { clearDocumentRenderTempDir } from './queue';
import { findReusableRenderSource, rebaseRenderMetadataKeys } from './reuse';

const log = debug('lobe-server:document-render');

const DENSE_PAGE_CHARS = 1200;
const MAX_BYTES_PER_IMAGE = 20 * 1024 * 1024;
const SIDECAR_UNAVAILABLE = 'sidecar unavailable';
const LEASE_TIMEOUT_GUARD_MS = 15_000;
const SIDECAR_CONNECTION_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

const isSidecarConnectionError = (error: unknown, depth = 0): boolean => {
  if (!error || depth > 4) return false;
  if (typeof error !== 'object') return false;
  const rec = error as { cause?: unknown; code?: unknown; message?: unknown; name?: unknown };
  // Worker abort (lease / job timeout) is not a sidecar outage.
  if (rec.name === 'AbortError') return false;
  if (typeof rec.code === 'string' && SIDECAR_CONNECTION_CODES.has(rec.code)) return true;
  if (typeof rec.message === 'string') {
    const message = rec.message.toLowerCase();
    if (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('econnreset') ||
      message.includes('fetch failed') ||
      message.includes('timed out') ||
      message.includes('timeout')
    ) {
      return true;
    }
  }
  return isSidecarConnectionError(rec.cause, depth + 1);
};

export class RenderAbortedError extends Error {
  constructor(message = 'document render aborted') {
    super(message);
    this.name = 'RenderAbortedError';
  }
}

export class FileDeletedDuringRenderError extends RenderAbortedError {
  constructor() {
    super('file deleted during render');
    this.name = 'FileDeletedDuringRenderError';
  }
}

/** Sidecar down / unreachable — thrown after a retryable `jobs.fail` so the lane backs off. */
export class SidecarUnavailableError extends Error {
  constructor(message = SIDECAR_UNAVAILABLE) {
    super(message);
    this.name = 'SidecarUnavailableError';
  }
}

/** Clamp the per-job timeout so work always finishes at least 15s before the lease expires. */
export const clampJobTimeoutMs = (timeoutSec: number, leaseMs: number): number =>
  Math.max(0, Math.min(timeoutSec * 1000, leaseMs - LEASE_TIMEOUT_GUARD_MS));

export const heartbeatIntervalMs = (leaseMs: number): number =>
  Math.max(1, Math.floor(leaseMs / 3));

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

interface RenderControl {
  abortLease: () => void;
  assertLive: () => void;
  signal: AbortSignal;
}

/** jsonb-merge into `files.metadata.render`. Omitting `status` leaves the worker's value intact. */
export const patchRenderMetadata = async (
  db: LobeChatDatabase,
  file: FileItem,
  patch: Partial<FileRenderMetadata>,
): Promise<FileRenderMetadata> => {
  const updatedAt = new Date().toISOString();
  const sqlPatch = { ...patch, updatedAt };
  const [row] = await db
    .update(files)
    .set({
      metadata: sql`coalesce(${files.metadata}, '{}'::jsonb) || jsonb_build_object('render', coalesce(${files.metadata} -> 'render', '{}'::jsonb) || ${JSON.stringify(sqlPatch)}::jsonb)`,
      updatedAt: sql`now()`,
    })
    .where(eq(files.id, file.id))
    .returning({ id: files.id, metadata: files.metadata });

  if (!row) {
    await deleteDocumentRenderArtifacts([file.id]);
    throw new FileDeletedDuringRenderError();
  }

  const prev = readFileRenderMetadata(file.metadata) ?? { status: patch.status ?? 'pending' };
  const next: FileRenderMetadata = readFileRenderMetadata(row.metadata) ?? {
    ...prev,
    ...patch,
    updatedAt,
  };
  file.metadata = (row.metadata as FileItem['metadata']) ?? {
    ...asMetadataRecord(file.metadata),
    render: next,
  };
  return next;
};

const ensureFileStillExists = async (db: LobeChatDatabase, fileId: string): Promise<void> => {
  const current = await FileModel.getFileById(db, fileId);
  if (current) return;
  await deleteDocumentRenderArtifacts([fileId]);
  throw new FileDeletedDuringRenderError();
};

const uploadFigures = async (
  fileId: string,
  kind: DocumentRenderKind,
  bytes: Uint8Array,
  db: LobeChatDatabase,
  control: RenderControl,
): Promise<FileRenderMetadata['figures']> => {
  if (kind === 'pdf' || kind === 'other') return [];
  control.assertLive();
  const extracted = await extractOoxmlFigures(bytes, kind);
  const figures = [];
  for (const [index, figure] of extracted.entries()) {
    control.assertLive();
    const key = documentRenderArtifactKeys.figure(fileId, figure.page, index + 1, figure.ext);
    await uploadImageArtifact(key, figure.bytes, figure.mimeType, control.signal);
    figures.push({ key, mimeType: figure.mimeType, page: figure.page });
  }
  await ensureFileStillExists(db, fileId);
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
  control: RenderControl;
  db: LobeChatDatabase;
  fileId: string;
  jobs: PlatformJobModel;
  jobId: string;
  leaseMs: number;
  pdfBytes: Uint8Array;
  settings: EffectiveDocumentRenderSettings;
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
    params.control.assertLive();
    if (image.kind === 'page') {
      const key = documentRenderArtifactKeys.page(fileId, image.page);
      await uploadPngArtifact(key, image.png, params.control.signal);
      const meta = pages[String(image.page)] ?? { chars: 0, visual: true };
      meta.png = key;
      if (image.thumb && image.thumb.byteLength > 0) {
        const thumbKey = documentRenderArtifactKeys.thumb(fileId, image.page);
        await uploadPngArtifact(thumbKey, image.thumb, params.control.signal);
        meta.thumb = thumbKey;
        thumbs.push({ page: image.page, png: image.thumb });
      }
      pages[String(image.page)] = meta;
      renderedPages.push(image.page);
      progress += 1;
      const checkpoint = await params.jobs.checkpoint({
        cursor: { page: image.page },
        jobId: params.jobId,
        leaseMs: params.leaseMs,
        progressDone: progress,
        progressTotal: capped.length,
        workerId: params.workerId,
      });
      if (!checkpoint) {
        params.control.abortLease();
        throw new RenderAbortedError('lease lost or cancelled');
      }
      await ensureFileStillExists(params.db, fileId);
      return;
    }
    if (image.kind === 'tile' && image.tile) {
      const key = documentRenderArtifactKeys.tile(
        fileId,
        image.page,
        image.tile.row,
        image.tile.col,
      );
      await uploadPngArtifact(key, image.png, params.control.signal);
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
    params.control.assertLive();
    const chunk = thumbs.slice(index, index + sheetSize);
    const sheet = await composeContactSheet({
      cols: settings.contactSheetCols,
      rows: settings.contactSheetRows,
      thumbs: chunk,
    });
    if (!sheet) continue;
    const key = documentRenderArtifactKeys.contactSheet(fileId, contactSheets.length);
    await uploadPngArtifact(key, sheet.png, params.control.signal);
    contactSheets.push({ key, pages: sheet.pages });
  }
  await ensureFileStillExists(params.db, fileId);

  return { contactSheets, failedPages, pages, renderedPages, truncated };
};

interface RenderOutcome {
  durationMs: number;
  pages: number | null;
  retry?: boolean;
  reused?: boolean;
  status: DocumentRenderStatus;
}

const withSheets = (
  patch: Partial<FileRenderMetadata> & Pick<FileRenderMetadata, 'status'>,
  sheets: FileRenderSheetMeta[] | undefined,
): Partial<FileRenderMetadata> & Pick<FileRenderMetadata, 'status'> =>
  sheets && sheets.length > 0 ? { ...patch, sheets } : patch;

const tryReuseRender = async (params: {
  control: RenderControl;
  db: LobeChatDatabase;
  file: FileItem;
  jobId: string;
  started: number;
}): Promise<RenderOutcome | undefined> => {
  const hash = params.file.fileHash;
  if (!hash) return undefined;

  const source = await findReusableRenderSource(params.db, {
    fileHash: hash,
    fileId: params.file.id,
  });
  if (!source) return undefined;
  const sourceRender = readFileRenderMetadata(source.metadata);
  if (!sourceRender) return undefined;

  params.control.assertLive();
  try {
    await copyDocumentRenderArtifacts(source.id, params.file.id);
  } catch (error) {
    log(
      'artifact reuse copy failed source=%s target=%s: %s',
      source.id,
      params.file.id,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
  params.control.assertLive();

  const rebased = rebaseRenderMetadataKeys(sourceRender, source.id, params.file.id);
  const durationMs = Date.now() - params.started;
  const status: DocumentRenderStatus =
    sourceRender.status === 'partial'
      ? 'partial'
      : sourceRender.status === 'ready'
        ? 'ready'
        : 'partial';
  await patchRenderMetadata(params.db, params.file, {
    ...rebased,
    copiedFrom: source.id,
    durationMs,
    jobId: params.jobId,
    status,
  });

  return {
    durationMs,
    pages: sourceRender.renderedPages?.length ?? sourceRender.pageCount ?? null,
    reused: true,
    status,
  };
};

const runRender = async (params: {
  control: RenderControl;
  db: LobeChatDatabase;
  file: FileItem;
  jobId: string;
  jobs: PlatformJobModel;
  leaseMs: number;
  settings: EffectiveDocumentRenderSettings;
  workerId: string;
}): Promise<RenderOutcome> => {
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

  const reused = await tryReuseRender({
    control: params.control,
    db,
    file,
    jobId: params.jobId,
    started,
  });
  if (reused) return reused;

  params.control.assertLive();
  const s3 = await createFileS3();
  params.control.assertLive();
  const bytes = await s3.getFileByteArray(file.url);
  params.control.assertLive();
  const classified = await classifyDocument(
    { bytes, fileType: file.fileType, name: file.name },
    { mediaThresholdT2: settings.mediaThresholdT2, pptxAlwaysT2: settings.pptxAlwaysT2 },
  );
  params.control.assertLive();
  const sheets = classified.kind === 'xlsx' ? await parseXlsxWorkbookSheets(bytes) : undefined;
  await patchRenderMetadata(db, file, {
    jobId: params.jobId,
    status: 'pending',
    tier: classified.tier,
  });

  if (classified.tier === 'T0') {
    await patchRenderMetadata(
      db,
      file,
      withSheets(
        {
          engine: classified.kind === 'pdf' ? 'pdfjs' : 'ooxml',
          hasTextLayer: true,
          pageCount: classified.pageCount,
          status: 'skipped',
          tier: 'T0',
        },
        sheets,
      ),
    );
    return {
      durationMs: Date.now() - started,
      pages: classified.pageCount ?? 0,
      status: 'skipped',
    };
  }

  if (classified.tier === 'T1') {
    const figures = await uploadFigures(file.id, classified.kind, bytes, db, params.control);
    await patchRenderMetadata(
      db,
      file,
      withSheets(
        {
          engine: 'ooxml',
          figures,
          hasTextLayer: true,
          status: 'ready',
          tier: 'T1',
        },
        sheets,
      ),
    );
    return { durationMs: Date.now() - started, pages: figures?.length ?? 0, status: 'ready' };
  }

  return runTier2({ ...params, bytes, classified, kind, sheets, started });
};

const runTier2 = async (params: {
  bytes: Uint8Array;
  classified: ClassifyDocumentResult;
  control: RenderControl;
  db: LobeChatDatabase;
  file: FileItem;
  jobId: string;
  jobs: PlatformJobModel;
  kind: DocumentRenderKind;
  leaseMs: number;
  settings: EffectiveDocumentRenderSettings;
  sheets: FileRenderSheetMeta[] | undefined;
  started: number;
  workerId: string;
}): Promise<RenderOutcome> => {
  const { bytes, classified, db, file, kind, settings, sheets } = params;
  const moduleOn = await isModuleEnabled('documentRender');
  const sidecarOk = moduleOn && isDocumentRenderConfigured(settings);

  let pdfBytes = bytes;
  let engine: DocumentRenderEngine = 'pdfjs';
  let pdfKey: string | undefined;

  if (kind !== 'pdf') {
    if (!sidecarOk || !settings.endpoint) {
      const figures = await uploadFigures(file.id, kind, bytes, db, params.control);
      await patchRenderMetadata(
        db,
        file,
        withSheets(
          {
            engine: 'ooxml',
            error: SIDECAR_UNAVAILABLE,
            figures,
            hasTextLayer: true,
            status: 'partial',
            tier: 'T2',
          },
          sheets,
        ),
      );
      return {
        durationMs: Date.now() - params.started,
        pages: figures?.length ?? 0,
        retry: true,
        status: 'partial',
      };
    }
    params.control.assertLive();
    try {
      pdfBytes = await convertToPdf(settings.endpoint, {
        bytes,
        filename: file.name,
        signal: params.control.signal,
        timeoutMs: clampJobTimeoutMs(settings.timeoutSec, params.leaseMs),
      });
    } catch (error) {
      if (params.control.signal.aborted || !isSidecarConnectionError(error)) throw error;
      const figures = await uploadFigures(file.id, kind, bytes, db, params.control);
      await patchRenderMetadata(
        db,
        file,
        withSheets(
          {
            engine: 'ooxml',
            error: SIDECAR_UNAVAILABLE,
            figures,
            hasTextLayer: true,
            status: 'partial',
            tier: 'T2',
          },
          sheets,
        ),
      );
      return {
        durationMs: Date.now() - params.started,
        pages: figures?.length ?? 0,
        retry: true,
        status: 'partial',
      };
    }
    params.control.assertLive();
    pdfKey = await uploadPdfArtifact(file.id, pdfBytes, params.control.signal);
    await ensureFileStillExists(db, file.id);
    engine = 'gotenberg';
  }

  const pdfClassified =
    kind === 'pdf'
      ? classified
      : await classifyDocument(
          { bytes: pdfBytes, fileType: 'application/pdf', name: `${file.name}.pdf` },
          settings,
        );
  params.control.assertLive();
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
    control: params.control,
    db,
    fileId: file.id,
    jobId: params.jobId,
    jobs: params.jobs,
    leaseMs: params.leaseMs,
    pdfBytes,
    settings,
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

  const textIndex: FileRenderTextIndex = {};
  for (const page of allPages) {
    if (!page.text) continue;
    textIndex[String(page.page)] = page.text;
  }
  const textIndexKey =
    Object.keys(textIndex).length > 0 ? documentRenderArtifactKeys.textIndex(file.id) : undefined;
  if (textIndexKey) {
    params.control.assertLive();
    await uploadJsonArtifact(textIndexKey, textIndex, params.control.signal);
  }

  await ensureFileStillExists(db, file.id);
  await patchRenderMetadata(
    db,
    file,
    withSheets(
      {
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
        ...(pdfKey ? { pdf: pdfKey } : {}),
        renderedPages: raster.renderedPages,
        status,
        ...(textIndexKey ? { textIndex: textIndexKey } : {}),
        tier: 'T2',
      },
      sheets,
    ),
  );

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
  let leaseLost = false;
  const control: RenderControl = {
    abortLease: () => {
      leaseLost = true;
      controller.abort();
    },
    assertLive: () => {
      if (!controller.signal.aborted) return;
      if (leaseLost) throw new RenderAbortedError('lease lost or cancelled');
      throw new Error('document render timed out');
    },
    signal: controller.signal,
  };
  const timeoutMs = clampJobTimeoutMs(settings.timeoutSec, ctx.spec.leaseMs);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const stopHeartbeat = (() => {
    const intervalMs = heartbeatIntervalMs(ctx.spec.leaseMs);
    const heartbeatTimer = setInterval(() => {
      if (controller.signal.aborted) return;
      void jobs.heartbeat(ctx.job.id, ctx.workerId, ctx.spec.leaseMs).then((row) => {
        if (!row) control.abortLease();
      });
    }, intervalMs);
    return () => clearInterval(heartbeatTimer);
  })();

  const logLostOwnership = (action: 'complete' | 'fail') => {
    log('lost ownership on %s jobId=%s', action, ctx.job.id);
  };

  try {
    if (!fileId) {
      const failed = await jobs.fail({
        error: { message: 'missing fileId' },
        jobId: ctx.job.id,
        terminal: true,
        workerId: ctx.workerId,
      });
      if (!failed) logLostOwnership('fail');
      return;
    }

    const file = await FileModel.getFileById(ctx.db, fileId);
    if (!file) {
      const completed = await jobs.complete({
        jobId: ctx.job.id,
        resultSummary: { status: 'skipped' },
        workerId: ctx.workerId,
      });
      if (!completed) logLostOwnership('complete');
      return;
    }

    try {
      const result = await runRender({
        control,
        db: ctx.db,
        file,
        jobId: ctx.job.id,
        jobs,
        leaseMs: ctx.spec.leaseMs,
        settings,
        workerId: ctx.workerId,
      });
      await patchRenderMetadata(ctx.db, file, {
        durationMs: result.durationMs,
        status: (readFileRenderMetadata(file.metadata)?.status ??
          result.status) as DocumentRenderStatus,
      });
      if (result.retry) {
        const failed = await jobs.fail({
          error: { message: SIDECAR_UNAVAILABLE, retryable: true },
          jobId: ctx.job.id,
          workerId: ctx.workerId,
        });
        if (!failed) {
          logLostOwnership('fail');
          return;
        }
        throw new SidecarUnavailableError();
      }
      const completed = await jobs.complete({
        jobId: ctx.job.id,
        resultSummary: {
          durationMs: result.durationMs,
          ext: extOf(file.name),
          fileId: file.id,
          pages: result.pages,
          ...(result.reused ? { reused: true } : {}),
          status: result.status,
        },
        workerId: ctx.workerId,
      });
      if (!completed) logLostOwnership('complete');
    } catch (error) {
      if (error instanceof SidecarUnavailableError) throw error;
      if (error instanceof FileDeletedDuringRenderError) {
        log('document render stopped, file deleted fileId=%s', fileId);
        const completed = await jobs.complete({
          jobId: ctx.job.id,
          resultSummary: { status: 'skipped' },
          workerId: ctx.workerId,
        });
        if (!completed) logLostOwnership('complete');
        return;
      }
      if (error instanceof RenderAbortedError || leaseLost) {
        log(
          'document render aborted fileId=%s: %s',
          fileId,
          error instanceof Error ? error.message : error,
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log('document render failed fileId=%s: %s', fileId, message);
      console.error('document render failed', error);
      await patchRenderMetadata(ctx.db, file, { error: message, status: 'failed' });
      const failed = await jobs.fail({
        error: { message },
        jobId: ctx.job.id,
        workerId: ctx.workerId,
      });
      if (!failed) {
        logLostOwnership('fail');
        return;
      }
      throw error;
    }
  } finally {
    stopHeartbeat();
    clearTimeout(timer);
  }
};
