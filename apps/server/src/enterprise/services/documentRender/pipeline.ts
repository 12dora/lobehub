import debug from 'debug';

import type { PlatformJobModel } from '@/database/models/platform/job';
import type { FileItem } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { isModuleEnabled } from '@/server/enterprise/services/moduleSettings';
import { createFileS3 } from '@/server/modules/S3';
import type {
  DocumentRenderEngine,
  FileRenderMetadata,
  FileRenderPageMeta,
  FileRenderSheetMeta,
  FileRenderTextIndex,
} from '@/types/files';
import { documentRenderArtifactKeys, readFileRenderMetadata } from '@/types/files';

import type { EffectiveDocumentRenderSettings } from '../documentRenderSettings';
import { isDocumentRenderConfigured } from '../documentRenderSettings';
import {
  copyDocumentRenderArtifacts,
  uploadImageArtifact,
  uploadJsonArtifact,
  uploadPdfArtifact,
} from './artifacts';
import type { ClassifyDocumentResult, DocumentRenderKind } from './classify';
import {
  classifyDocument,
  isRenderableDocumentKind,
  parseXlsxWorkbookSheets,
  resolveDocumentKind,
} from './classify';
import type { RenderControl } from './control';
import { clampJobTimeoutMs, isSidecarConnectionError, SIDECAR_UNAVAILABLE } from './control';
import { extractOoxmlFigures } from './figures';
import { convertToPdf } from './gotenbergClient';
import type { RenderOutcome } from './persist';
import { ensureFileStillExists, patchRenderMetadata, withSheets } from './persist';
import type { RasterizeResult } from './rasterize';
import { rasterizePdf } from './rasterize';
import { findReusableRenderSource, rebaseRenderMetadataKeys } from './reuse';

const log = debug('lobe-server:document-render');

interface RenderJobParams {
  control: RenderControl;
  db: LobeChatDatabase;
  file: FileItem;
  jobId: string;
  jobs: PlatformJobModel;
  leaseMs: number;
  settings: EffectiveDocumentRenderSettings;
  workerId: string;
}

interface Tier2Params extends RenderJobParams {
  bytes: Uint8Array;
  classified: ClassifyDocumentResult;
  kind: DocumentRenderKind;
  sheets: FileRenderSheetMeta[] | undefined;
  started: number;
}

interface PreparedPdf {
  engine: DocumentRenderEngine;
  pdfBytes: Uint8Array;
  pdfKey?: string;
}

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
  const status: RenderOutcome['status'] = sourceRender.status;
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

const skipUnrenderableFile = async (params: {
  db: LobeChatDatabase;
  file: FileItem;
  kind: DocumentRenderKind;
  settings: EffectiveDocumentRenderSettings;
  started: number;
}): Promise<RenderOutcome | undefined> => {
  if (!isRenderableDocumentKind(params.kind)) {
    await patchRenderMetadata(params.db, params.file, { status: 'skipped', tier: 'T0' });
    return { durationMs: Date.now() - params.started, pages: null, status: 'skipped' };
  }

  if (params.file.size > params.settings.maxFileBytes) {
    await patchRenderMetadata(params.db, params.file, {
      error: `file exceeds maxFileBytes (${params.settings.maxFileBytes})`,
      status: 'skipped',
    });
    return { durationMs: Date.now() - params.started, pages: null, status: 'skipped' };
  }

  return undefined;
};

const runTier0 = async (params: {
  classified: ClassifyDocumentResult;
  db: LobeChatDatabase;
  file: FileItem;
  sheets: FileRenderSheetMeta[] | undefined;
  started: number;
}): Promise<RenderOutcome> => {
  await patchRenderMetadata(
    params.db,
    params.file,
    withSheets(
      {
        engine: params.classified.kind === 'pdf' ? 'pdfjs' : 'ooxml',
        hasTextLayer: true,
        pageCount: params.classified.pageCount,
        status: 'skipped',
        tier: 'T0',
      },
      params.sheets,
    ),
  );
  return {
    durationMs: Date.now() - params.started,
    pages: params.classified.pageCount ?? 0,
    status: 'skipped',
  };
};

const runTier1 = async (params: {
  bytes: Uint8Array;
  classified: ClassifyDocumentResult;
  control: RenderControl;
  db: LobeChatDatabase;
  file: FileItem;
  sheets: FileRenderSheetMeta[] | undefined;
  started: number;
}): Promise<RenderOutcome> => {
  const figures = await uploadFigures(
    params.file.id,
    params.classified.kind,
    params.bytes,
    params.db,
    params.control,
  );
  await patchRenderMetadata(
    params.db,
    params.file,
    withSheets(
      {
        engine: 'ooxml',
        figures,
        hasTextLayer: true,
        status: 'ready',
        tier: 'T1',
      },
      params.sheets,
    ),
  );
  return { durationMs: Date.now() - params.started, pages: figures?.length ?? 0, status: 'ready' };
};

const persistSidecarUnavailablePartial = async (params: Tier2Params): Promise<RenderOutcome> => {
  const figures = await uploadFigures(
    params.file.id,
    params.kind,
    params.bytes,
    params.db,
    params.control,
  );
  await patchRenderMetadata(
    params.db,
    params.file,
    withSheets(
      {
        engine: 'ooxml',
        error: SIDECAR_UNAVAILABLE,
        figures,
        hasTextLayer: true,
        status: 'partial',
        tier: 'T2',
      },
      params.sheets,
    ),
  );
  return {
    durationMs: Date.now() - params.started,
    pages: figures?.length ?? 0,
    retry: true,
    status: 'partial',
  };
};

const preparePdfForTier2 = async (
  params: Tier2Params,
  sidecarOk: boolean,
): Promise<PreparedPdf | RenderOutcome> => {
  if (params.kind === 'pdf') {
    return { engine: 'pdfjs', pdfBytes: params.bytes };
  }
  if (!sidecarOk || !params.settings.endpoint) {
    return persistSidecarUnavailablePartial(params);
  }
  params.control.assertLive();
  let pdfBytes: Uint8Array;
  // ONLY the conversion is guarded. `isSidecarConnectionError` matches connection-shaped failures
  // wherever they come from, so widening this to cover the artifact upload and the existence check
  // would report a dropped S3 connection as "the sidecar is down": a retryable `partial` carrying
  // SIDECAR_UNAVAILABLE, instead of the failure it is.
  try {
    pdfBytes = await convertToPdf(params.settings.endpoint, {
      bytes: params.bytes,
      filename: params.file.name,
      signal: params.control.signal,
      timeoutMs: clampJobTimeoutMs(params.settings.timeoutSec, params.leaseMs),
    });
  } catch (error) {
    if (params.control.signal.aborted || !isSidecarConnectionError(error)) throw error;
    return persistSidecarUnavailablePartial(params);
  }
  params.control.assertLive();
  const pdfKey = await uploadPdfArtifact(params.file.id, pdfBytes, params.control.signal);
  await ensureFileStillExists(params.db, params.file.id);
  return { engine: 'gotenberg', pdfBytes, pdfKey };
};

const classifyPdfForRaster = async (
  params: Tier2Params,
  pdfBytes: Uint8Array,
): Promise<ClassifyDocumentResult> => {
  const pdfClassified =
    params.kind === 'pdf'
      ? params.classified
      : await classifyDocument(
          { bytes: pdfBytes, fileType: 'application/pdf', name: `${params.file.name}.pdf` },
          params.settings,
        );
  params.control.assertLive();
  return pdfClassified;
};

const selectVisualPages = (kind: DocumentRenderKind, pdfClassified: ClassifyDocumentResult) => {
  // Slides carry layout even when text-only, so a deck renders every page;
  // docx/xlsx/pdf render only pages that actually have visual content.
  const everyPageVisual = kind === 'pptx';
  const allPages = pdfClassified.pages ?? [];
  const visualPages = allPages
    .filter((page) => everyPageVisual || page.visual)
    .map((page) => ({ chars: page.chars, page: page.page }));
  const pageMeta: Record<string, FileRenderPageMeta> = {};
  for (const page of allPages) {
    pageMeta[String(page.page)] = {
      chars: page.chars,
      visual: everyPageVisual || page.visual,
    };
  }
  return { allPages, pageMeta, visualPages };
};

const uploadTextIndex = async (
  fileId: string,
  allPages: NonNullable<ClassifyDocumentResult['pages']>,
  control: RenderControl,
): Promise<string | undefined> => {
  const textIndex: FileRenderTextIndex = {};
  for (const page of allPages) {
    if (!page.text) continue;
    textIndex[String(page.page)] = page.text;
  }
  const textIndexKey =
    Object.keys(textIndex).length > 0 ? documentRenderArtifactKeys.textIndex(fileId) : undefined;
  if (textIndexKey) {
    control.assertLive();
    await uploadJsonArtifact(textIndexKey, textIndex, control.signal);
  }
  return textIndexKey;
};

const persistTier2Result = async (params: {
  allPages: NonNullable<ClassifyDocumentResult['pages']>;
  engine: DocumentRenderEngine;
  file: FileItem;
  db: LobeChatDatabase;
  pageMeta: Record<string, FileRenderPageMeta>;
  pdfClassified: ClassifyDocumentResult;
  pdfKey: string | undefined;
  raster: RasterizeResult;
  sheets: FileRenderSheetMeta[] | undefined;
  started: number;
  textIndexKey: string | undefined;
}): Promise<RenderOutcome> => {
  const { raster } = params;
  const pages = { ...params.pageMeta, ...raster.pages };
  const hasTextLayer = params.allPages.some((page) => page.chars >= 20);
  const partial = raster.failedPages > 0 || raster.truncated;
  const status: RenderOutcome['status'] = partial ? 'partial' : 'ready';

  await ensureFileStillExists(params.db, params.file.id);
  await patchRenderMetadata(
    params.db,
    params.file,
    withSheets(
      {
        contactSheets: raster.contactSheets,
        engine: params.engine,
        error: raster.truncated
          ? 'maxPages truncated'
          : raster.failedPages > 0
            ? 'some pages failed'
            : null,
        hasTextLayer,
        pageCount: params.pdfClassified.pageCount ?? params.allPages.length,
        pages,
        ...(params.pdfKey ? { pdf: params.pdfKey } : {}),
        renderedPages: raster.renderedPages,
        status,
        ...(params.textIndexKey ? { textIndex: params.textIndexKey } : {}),
        tier: 'T2',
      },
      params.sheets,
    ),
  );

  return {
    durationMs: Date.now() - params.started,
    pages: raster.renderedPages.length,
    status,
  };
};

const runTier2 = async (params: Tier2Params): Promise<RenderOutcome> => {
  const moduleOn = await isModuleEnabled('documentRender');
  const sidecarOk = moduleOn && isDocumentRenderConfigured(params.settings);

  const prepared = await preparePdfForTier2(params, sidecarOk);
  if (!('pdfBytes' in prepared)) return prepared;

  const pdfClassified = await classifyPdfForRaster(params, prepared.pdfBytes);
  const { allPages, pageMeta, visualPages } = selectVisualPages(params.kind, pdfClassified);

  const raster = await rasterizePdf({
    control: params.control,
    db: params.db,
    fileId: params.file.id,
    jobId: params.jobId,
    jobs: params.jobs,
    leaseMs: params.leaseMs,
    pdfBytes: prepared.pdfBytes,
    settings: params.settings,
    visualPages:
      visualPages.length > 0
        ? visualPages
        : allPages.map((page) => ({ chars: page.chars, page: page.page })),
    workerId: params.workerId,
  });

  const textIndexKey = await uploadTextIndex(params.file.id, allPages, params.control);

  return persistTier2Result({
    allPages,
    db: params.db,
    engine: prepared.engine,
    file: params.file,
    pageMeta,
    pdfClassified,
    pdfKey: prepared.pdfKey,
    raster,
    sheets: params.sheets,
    started: params.started,
    textIndexKey,
  });
};

export const runRender = async (params: RenderJobParams): Promise<RenderOutcome> => {
  const started = Date.now();
  const { db, file, settings } = params;
  const kind = resolveDocumentKind(file.name, file.fileType);

  const skipped = await skipUnrenderableFile({ db, file, kind, settings, started });
  if (skipped) return skipped;

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
    return runTier0({ classified, db, file, sheets, started });
  }

  if (classified.tier === 'T1') {
    return runTier1({ bytes, classified, control: params.control, db, file, sheets, started });
  }

  return runTier2({ ...params, bytes, classified, kind, sheets, started });
};
