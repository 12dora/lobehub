import type { PlatformJobModel } from '@/database/models/platform/job';
import type { LobeChatDatabase } from '@/database/type';
import type { PdfPageImage } from '@/server/modules/ModelRuntime/pdfPageImages';
import { renderPdfPagesToPng } from '@/server/modules/ModelRuntime/pdfPageImages';
import type { FileRenderMetadata, FileRenderPageMeta } from '@/types/files';
import { documentRenderArtifactKeys } from '@/types/files';

import type { EffectiveDocumentRenderSettings } from '../documentRenderSettings';
import { composeContactSheet, uploadPngArtifact } from './artifacts';
import type { RenderControl } from './control';
import { RenderAbortedError } from './control';
import { ensureFileStillExists } from './persist';

const DENSE_PAGE_CHARS = 1200;
const MAX_BYTES_PER_IMAGE = 20 * 1024 * 1024;

export interface RasterizeResult {
  contactSheets: NonNullable<FileRenderMetadata['contactSheets']>;
  failedPages: number;
  pages: Record<string, FileRenderPageMeta>;
  renderedPages: number[];
  truncated: boolean;
}

interface RasterizeSession {
  capped: Array<{ chars: number; page: number }>;
  control: RenderControl;
  db: LobeChatDatabase;
  fileId: string;
  jobId: string;
  jobs: PlatformJobModel;
  leaseMs: number;
  pages: Record<string, FileRenderPageMeta>;
  progress: number;
  renderedPages: number[];
  thumbs: Array<{ page: number; png: Uint8Array }>;
  workerId: string;
}

const handleRasterPageImage = async (
  session: RasterizeSession,
  image: PdfPageImage,
): Promise<void> => {
  session.control.assertLive();
  if (image.kind === 'page') {
    const key = documentRenderArtifactKeys.page(session.fileId, image.page);
    await uploadPngArtifact(key, image.png, session.control.signal);
    const meta = session.pages[String(image.page)] ?? { chars: 0, visual: true };
    meta.png = key;
    if (image.thumb && image.thumb.byteLength > 0) {
      const thumbKey = documentRenderArtifactKeys.thumb(session.fileId, image.page);
      await uploadPngArtifact(thumbKey, image.thumb, session.control.signal);
      meta.thumb = thumbKey;
      session.thumbs.push({ page: image.page, png: image.thumb });
    }
    session.pages[String(image.page)] = meta;
    session.renderedPages.push(image.page);
    session.progress += 1;
    const checkpoint = await session.jobs.checkpoint({
      cursor: { page: image.page },
      jobId: session.jobId,
      leaseMs: session.leaseMs,
      progressDone: session.progress,
      progressTotal: session.capped.length,
      workerId: session.workerId,
    });
    if (!checkpoint) {
      session.control.abortLease();
      throw new RenderAbortedError('lease lost or cancelled');
    }
    await ensureFileStillExists(session.db, session.fileId);
    return;
  }
  if (image.kind === 'tile' && image.tile) {
    const key = documentRenderArtifactKeys.tile(
      session.fileId,
      image.page,
      image.tile.row,
      image.tile.col,
    );
    await uploadPngArtifact(key, image.png, session.control.signal);
    const meta = session.pages[String(image.page)] ?? { chars: 0, visual: true };
    meta.tiles = [...(meta.tiles ?? []), key];
    session.pages[String(image.page)] = meta;
  }
};

const uploadContactSheets = async (params: {
  control: RenderControl;
  db: LobeChatDatabase;
  fileId: string;
  settings: EffectiveDocumentRenderSettings;
  thumbs: Array<{ page: number; png: Uint8Array }>;
}): Promise<NonNullable<FileRenderMetadata['contactSheets']>> => {
  const contactSheets: NonNullable<FileRenderMetadata['contactSheets']> = [];
  const sheetSize = params.settings.contactSheetCols * params.settings.contactSheetRows;
  for (let index = 0; index < params.thumbs.length; index += sheetSize) {
    params.control.assertLive();
    const chunk = params.thumbs.slice(index, index + sheetSize);
    const sheet = await composeContactSheet({
      cols: params.settings.contactSheetCols,
      rows: params.settings.contactSheetRows,
      thumbs: chunk,
    });
    if (!sheet) continue;
    const key = documentRenderArtifactKeys.contactSheet(params.fileId, contactSheets.length);
    await uploadPngArtifact(key, sheet.png, params.control.signal);
    contactSheets.push({ key, pages: sheet.pages });
  }
  await ensureFileStillExists(params.db, params.fileId);
  return contactSheets;
};

export const rasterizePdf = async (params: {
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
  const session: RasterizeSession = {
    capped,
    control: params.control,
    db: params.db,
    fileId,
    jobId: params.jobId,
    jobs: params.jobs,
    leaseMs: params.leaseMs,
    pages,
    progress: 0,
    renderedPages: [],
    thumbs: [],
    workerId: params.workerId,
  };
  const densePages = settings.tilesForDensePages
    ? capped.filter((page) => page.chars > DENSE_PAGE_CHARS).map((page) => page.page)
    : [];

  await renderPdfPagesToPng(params.pdfBytes, {
    maxBytesPerImage: MAX_BYTES_PER_IMAGE,
    maxLongEdgePx: settings.longEdgePx,
    maxPages: settings.maxPages,
    onPage: (image) => handleRasterPageImage(session, image),
    pages: capped.map((page) => page.page),
    retainResults: false,
    thumbLongEdgePx: settings.thumbEdgePx,
    tiles:
      densePages.length > 0
        ? { grid: 2, maxLongEdgePx: settings.longEdgePx, pages: densePages }
        : undefined,
  });

  const failedPages = capped.filter((page) => !pages[String(page.page)]?.png).length;
  const contactSheets = await uploadContactSheets({
    control: params.control,
    db: params.db,
    fileId,
    settings,
    thumbs: session.thumbs,
  });

  return {
    contactSheets,
    failedPages,
    pages,
    renderedPages: session.renderedPages,
    truncated,
  };
};
