import type { FileItem } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { isModuleEnabled } from '@/server/enterprise/services/moduleSettings';
import { createFileS3 } from '@/server/modules/S3';
import type { DocumentPreviewResult, FileRenderMetadata } from '@/types/files';
import { readFileRenderMetadata } from '@/types/files';

import {
  getEffectiveDocumentRenderSettings,
  isDocumentRenderConfigured,
} from '../documentRenderSettings';
import { uploadPdfArtifact } from './artifacts';
import type { DocumentRenderKind } from './classify';
import { resolveDocumentKind } from './classify';
import { convertToPdf } from './gotenbergClient';
import { patchRenderMetadata } from './worker';

const PREVIEW_PRESIGN_EXPIRES_SEC = 15 * 60;
const PREVIEW_CONVERT_TIMEOUT_MS = 30_000;
const PREVIEW_FLIGHT_WAIT_MS = 20_000;
const PREVIEW_IN_FLIGHT_FRESH_MS = 2 * 60_000;
const PREVIEW_SINGLE_FLIGHT_CAP = 200;
const PREVIEW_FLIGHTS_KEY = Symbol.for('enterprise.documentRender.previewFlights');

const SIDECAR_CONNECTION_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

type PreviewFlightsGlobal = {
  [PREVIEW_FLIGHTS_KEY]?: Map<string, Promise<DocumentPreviewResult>>;
};

const previewFlightsGlobal = globalThis as unknown as PreviewFlightsGlobal;

const previewFlights = (): Map<string, Promise<DocumentPreviewResult>> =>
  (previewFlightsGlobal[PREVIEW_FLIGHTS_KEY] ??= new Map());

/** Test-only: drop in-flight preview conversions. */
export const resetDocumentPreviewFlightsForTest = (): void => {
  previewFlightsGlobal[PREVIEW_FLIGHTS_KEY]?.clear();
};

/**
 * Legacy / OpenDocument office formats that `resolveDocumentKind` classifies as
 * `other` (the render pipeline never tiers them) but LibreOffice behind Gotenberg
 * converts fine, so the preview path accepts them for on-demand conversion.
 */
const LEGACY_OFFICE_EXTENSIONS = ['.doc', '.ppt', '.xls', '.odt', '.odp', '.ods', '.rtf'];

const isOfficePreviewKind = (kind: DocumentRenderKind, name: string): boolean =>
  kind === 'docx' ||
  kind === 'pptx' ||
  kind === 'xlsx' ||
  (kind === 'other' &&
    LEGACY_OFFICE_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension)));

const isSidecarConnectionError = (error: unknown, depth = 0): boolean => {
  if (!error || depth > 4) return false;
  if (typeof error !== 'object') return false;
  const rec = error as { cause?: unknown; code?: unknown; message?: unknown; name?: unknown };
  if (rec.name === 'AbortError') return false;
  if (typeof rec.code === 'string' && SIDECAR_CONNECTION_CODES.has(rec.code)) return true;
  if (typeof rec.message === 'string') {
    const message = rec.message.toLowerCase();
    if (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('econnreset') ||
      message.includes('fetch failed')
    ) {
      return true;
    }
  }
  return isSidecarConnectionError(rec.cause, depth + 1);
};

const sanitizePreviewError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'conversion failed';
  const http = error.message.match(/HTTP (\d{3})/);
  if (http) return `conversion failed (HTTP ${http[1]})`;
  if (/timed out|timeout/i.test(error.message)) return 'conversion timed out';
  return 'conversion failed';
};

const isPdfProducingJobInFlight = (render: FileRenderMetadata | undefined): boolean => {
  if (!render || render.status !== 'pending') return false;
  if (render.tier === 'T0' || render.tier === 'T1') return false;
  if (typeof render.updatedAt !== 'string') return false;
  const updatedAt = Date.parse(render.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  return Date.now() - updatedAt < PREVIEW_IN_FLIGHT_FRESH_MS;
};

const tryPresignExistingPdf = async (
  render: FileRenderMetadata,
): Promise<DocumentPreviewResult | undefined> => {
  if (typeof render.pdf !== 'string' || render.pdf.length === 0) return undefined;
  try {
    const s3 = await createFileS3();
    await s3.getFileMetadata(render.pdf);
    const url = await s3.createPreSignedUrlForPreview(render.pdf, PREVIEW_PRESIGN_EXPIRES_SEC);
    return {
      status: 'ready',
      url,
      ...(typeof render.pageCount === 'number' ? { pageCount: render.pageCount } : {}),
    };
  } catch {
    return undefined;
  }
};

const waitForSharedFlight = async (
  flight: Promise<DocumentPreviewResult>,
): Promise<DocumentPreviewResult> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      flight,
      new Promise<DocumentPreviewResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'pending' }), PREVIEW_FLIGHT_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const runPreviewConversion = async (params: {
  db: LobeChatDatabase;
  file: FileItem;
}): Promise<DocumentPreviewResult> => {
  const { db, file } = params;
  const moduleOn = await isModuleEnabled('documentRender');
  const settings = await getEffectiveDocumentRenderSettings({ db });
  if (!moduleOn || !isDocumentRenderConfigured(settings) || !settings.endpoint) {
    return { status: 'unavailable' };
  }

  if (file.size > settings.maxFileBytes) {
    return { error: 'file exceeds max size', status: 'failed' };
  }

  try {
    const s3 = await createFileS3();
    const bytes = await s3.getFileByteArray(file.url);
    const pdfBytes = await convertToPdf(settings.endpoint, {
      bytes,
      filename: file.name,
      timeoutMs: Math.min(PREVIEW_CONVERT_TIMEOUT_MS, settings.timeoutSec * 1000),
    });
    const key = await uploadPdfArtifact(file.id, pdfBytes);
    await patchRenderMetadata(db, file, { pdf: key });
    const url = await s3.createPreSignedUrlForPreview(key, PREVIEW_PRESIGN_EXPIRES_SEC);
    const pageCount = readFileRenderMetadata(file.metadata)?.pageCount;
    return {
      status: 'ready',
      url,
      ...(typeof pageCount === 'number' ? { pageCount } : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'FileDeletedDuringRenderError') {
      return { error: 'file not found', status: 'failed' };
    }
    if (isSidecarConnectionError(error)) return { status: 'unavailable' };
    return { error: sanitizePreviewError(error), status: 'failed' };
  }
};

const convertOnDemand = async (params: {
  db: LobeChatDatabase;
  file: FileItem;
}): Promise<DocumentPreviewResult> => {
  const flights = previewFlights();
  const existing = flights.get(params.file.id);
  if (existing) return waitForSharedFlight(existing);

  if (flights.size >= PREVIEW_SINGLE_FLIGHT_CAP) {
    return { status: 'pending' };
  }

  const flight = runPreviewConversion(params).finally(() => {
    flights.delete(params.file.id);
  });
  flights.set(params.file.id, flight);
  return flight;
};

export const getDocumentPreview = async (params: {
  db: LobeChatDatabase;
  file: FileItem;
  userId: string;
}): Promise<DocumentPreviewResult> => {
  const { db, file } = params;
  const kind = resolveDocumentKind(file.name, file.fileType);
  if (!isOfficePreviewKind(kind, file.name)) return { status: 'unsupported' };

  const render = readFileRenderMetadata(file.metadata);
  if (render) {
    const existing = await tryPresignExistingPdf(render);
    if (existing) return existing;
  }

  if (isPdfProducingJobInFlight(render)) return { status: 'pending' };

  return convertOnDemand({ db, file });
};
