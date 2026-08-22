import type {
  AdminSystemDocumentRenderSettings,
  AdminSystemUpdateDocumentRenderSettingsInput,
} from '@/enterprise/client/services/adminSystem';
import type { PlatformDocumentRenderSettings } from '@/types/platform/documentRenderSettings';

/** Named once so the card, the page gate and the modules registry can never disagree. */
export const DOCUMENT_RENDER_MODULE_ID = 'documentRender';

const MIB = 1024 * 1024;

/**
 * The editable form state.
 *
 * Numbers live as strings so a half-typed value never round-trips through `Number()` and back into
 * the input, and `maxFileBytes` is edited in MiB — an operator reasons about "32 MB", not
 * "33554432".
 */
export interface DocumentRenderDraft {
  concurrency: string;
  contactSheetCols: string;
  contactSheetRows: string;
  endpoint: string;
  longEdgePx: string;
  maxDocsPerRequest: string;
  maxFileBytesMib: string;
  maxImagesDefault: string;
  maxPages: string;
  mediaThresholdT2: string;
  pptxAlwaysT2: boolean;
  retentionDays: string;
  thumbEdgePx: string;
  tilesForDensePages: boolean;
  timeoutSec: string;
  trigger: 'onDemand' | 'onUpload';
}

/** Bytes → MiB for display; keeps two decimals so a non-round env value survives a round trip. */
export const bytesToMib = (bytes: number): string => {
  const mib = bytes / MIB;
  return String(Number.isInteger(mib) ? mib : Math.round(mib * 100) / 100);
};

export const toDocumentRenderDraft = (
  view: AdminSystemDocumentRenderSettings,
): DocumentRenderDraft => ({
  concurrency: String(view.config.concurrency),
  contactSheetCols: String(view.config.contactSheetCols),
  contactSheetRows: String(view.config.contactSheetRows),
  endpoint: view.config.endpoint ?? '',
  longEdgePx: String(view.config.longEdgePx),
  maxDocsPerRequest: String(view.config.maxDocsPerRequest),
  maxFileBytesMib: bytesToMib(view.config.maxFileBytes),
  maxImagesDefault: String(view.config.maxImagesDefault),
  maxPages: String(view.config.maxPages),
  mediaThresholdT2: String(view.config.mediaThresholdT2),
  pptxAlwaysT2: view.config.pptxAlwaysT2,
  retentionDays: String(view.config.retentionDays),
  thumbEdgePx: String(view.config.thumbEdgePx),
  tilesForDensePages: view.config.tilesForDensePages,
  timeoutSec: String(view.config.timeoutSec),
  trigger: view.config.trigger,
});

export const fingerprintDocumentRenderDraft = (draft: DocumentRenderDraft): string =>
  JSON.stringify(draft);

const parsePositiveInt = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return parsed > 0 ? parsed : undefined;
};

const parseNonNegativeInt = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
};

const parsePositiveNumber = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};

const parseBoundedInt = (value: string, min: number, max: number): number | undefined => {
  const parsed = parsePositiveInt(value);
  if (parsed === undefined || parsed < min || parsed > max) return undefined;
  return parsed;
};

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * The bounded fields carry their own message key: `errors.positiveInt` is true but useless when the
 * value has to be 1–6, and the shared error renderer resolves a key without interpolation values.
 */
export const validateDocumentRenderDraft = (draft: DocumentRenderDraft): Record<string, string> => {
  const errors: Record<string, string> = {};

  const endpoint = draft.endpoint.trim();
  // Empty is legal — it hands the address back to `DOCUMENT_RENDER_URL`.
  if (endpoint.length > 512) errors.endpoint = 'tooLong';
  else if (endpoint && !isHttpUrl(endpoint)) errors.endpoint = 'url';

  const positiveInts = [
    'concurrency',
    'maxDocsPerRequest',
    'maxImagesDefault',
    'maxPages',
    'mediaThresholdT2',
    'timeoutSec',
  ] as const;
  for (const field of positiveInts) {
    if (parsePositiveInt(draft[field]) === undefined) errors[field] = 'positiveInt';
  }

  if (parsePositiveNumber(draft.maxFileBytesMib) === undefined) {
    errors.maxFileBytesMib = 'positiveNumber';
  }
  if (parseNonNegativeInt(draft.retentionDays) === undefined) {
    errors.retentionDays = 'nonNegativeInt';
  }
  if (parseBoundedInt(draft.contactSheetCols, 1, 6) === undefined) {
    errors.contactSheetCols = 'contactSheetCols';
  }
  if (parseBoundedInt(draft.contactSheetRows, 1, 8) === undefined) {
    errors.contactSheetRows = 'contactSheetRows';
  }
  if (parseBoundedInt(draft.longEdgePx, 256, 4096) === undefined) {
    errors.longEdgePx = 'longEdgePx';
  }
  if (parseBoundedInt(draft.thumbEdgePx, 128, 1024) === undefined) {
    errors.thumbEdgePx = 'thumbEdgePx';
  }

  return errors;
};

/**
 * `enabled: false` is the whole payload for a revert: the stored row is dropped and the environment
 * takes the dependency back, so sending the current draft with it would only invite a partial write.
 */
export const toDocumentRenderConfig = (
  draft: DocumentRenderDraft,
  enabled: boolean,
): PlatformDocumentRenderSettings => {
  if (!enabled) return { enabled: false };

  const endpoint = draft.endpoint.trim();
  const maxFileBytesMib = parsePositiveNumber(draft.maxFileBytesMib);

  return {
    concurrency: parsePositiveInt(draft.concurrency),
    contactSheetCols: parseBoundedInt(draft.contactSheetCols, 1, 6),
    contactSheetRows: parseBoundedInt(draft.contactSheetRows, 1, 8),
    enabled: true,
    longEdgePx: parseBoundedInt(draft.longEdgePx, 256, 4096),
    maxDocsPerRequest: parsePositiveInt(draft.maxDocsPerRequest),
    maxFileBytes: maxFileBytesMib === undefined ? undefined : Math.round(maxFileBytesMib * MIB),
    maxImagesDefault: parsePositiveInt(draft.maxImagesDefault),
    maxPages: parsePositiveInt(draft.maxPages),
    mediaThresholdT2: parsePositiveInt(draft.mediaThresholdT2),
    pptxAlwaysT2: draft.pptxAlwaysT2,
    retentionDays: parseNonNegativeInt(draft.retentionDays),
    thumbEdgePx: parseBoundedInt(draft.thumbEdgePx, 128, 1024),
    tilesForDensePages: draft.tilesForDensePages,
    timeoutSec: parsePositiveInt(draft.timeoutSec),
    trigger: draft.trigger,
    ...(endpoint ? { endpoint } : {}),
  };
};

export const toDocumentRenderUpdateInput = (
  draft: DocumentRenderDraft,
  enabled: boolean,
  expectedRevision: number,
): AdminSystemUpdateDocumentRenderSettingsInput => ({
  config: toDocumentRenderConfig(draft, enabled),
  expectedRevision,
});
