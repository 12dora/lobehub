import { getServerDB } from '@/database/core/db-adaptor';
import { PlatformDocumentRenderSettingsModel } from '@/database/models/platform/documentRenderSettings';
import { documentRenderEnv } from '@/envs/documentRender';
import type {
  DocumentRenderTrigger,
  PlatformDocumentRenderSettings,
} from '@/types/platform/documentRenderSettings';
import {
  DOCUMENT_RENDER_DEFAULTS,
  normalizeDocumentRenderSettings,
} from '@/types/platform/documentRenderSettings';

const CACHE_TTL_MS = 30_000;

export interface DocumentRenderEnvBag {
  DOCUMENT_RENDER_CONCURRENCY?: number;
  DOCUMENT_RENDER_LONG_EDGE_PX?: number;
  DOCUMENT_RENDER_MAX_FILE_BYTES?: number;
  DOCUMENT_RENDER_MAX_PAGES?: number;
  DOCUMENT_RENDER_THUMB_EDGE_PX?: number;
  DOCUMENT_RENDER_TIMEOUT_SEC?: number;
  DOCUMENT_RENDER_TRIGGER?: DocumentRenderTrigger;
  DOCUMENT_RENDER_URL?: string;
}

/** Fully resolved document-render settings used by the worker, feeder, and admin view. */
export interface EffectiveDocumentRenderSettings {
  concurrency: number;
  contactSheetCols: number;
  contactSheetRows: number;
  endpoint?: string;
  longEdgePx: number;
  maxDocsPerRequest: number;
  maxFileBytes: number;
  maxImagesDefault: number;
  maxPages: number;
  mediaThresholdT2: number;
  pptxAlwaysT2: boolean;
  retentionDays: number;
  revision: number;
  source: 'db' | 'env';
  thumbEdgePx: number;
  tilesForDensePages: boolean;
  timeoutSec: number;
  trigger: DocumentRenderTrigger;
}

interface CacheSlot {
  expiresAt: number;
  value: EffectiveDocumentRenderSettings;
}

let cache: CacheSlot | null = null;

export const readDocumentRenderEnvBag = (override?: DocumentRenderEnvBag): DocumentRenderEnvBag => {
  if (override) return override;
  return {
    DOCUMENT_RENDER_CONCURRENCY: documentRenderEnv.DOCUMENT_RENDER_CONCURRENCY,
    DOCUMENT_RENDER_LONG_EDGE_PX: documentRenderEnv.DOCUMENT_RENDER_LONG_EDGE_PX,
    DOCUMENT_RENDER_MAX_FILE_BYTES: documentRenderEnv.DOCUMENT_RENDER_MAX_FILE_BYTES,
    DOCUMENT_RENDER_MAX_PAGES: documentRenderEnv.DOCUMENT_RENDER_MAX_PAGES,
    DOCUMENT_RENDER_THUMB_EDGE_PX: documentRenderEnv.DOCUMENT_RENDER_THUMB_EDGE_PX,
    DOCUMENT_RENDER_TIMEOUT_SEC: documentRenderEnv.DOCUMENT_RENDER_TIMEOUT_SEC,
    DOCUMENT_RENDER_TRIGGER: documentRenderEnv.DOCUMENT_RENDER_TRIGGER,
    DOCUMENT_RENDER_URL: documentRenderEnv.DOCUMENT_RENDER_URL,
  };
};

const pick = <T>(dbValue: T | undefined, envValue: T | undefined, fallback: T): T => {
  if (dbValue !== undefined && dbValue !== null) return dbValue;
  if (envValue !== undefined && envValue !== null) return envValue;
  return fallback;
};

const pickOptional = (dbValue: string | undefined, envValue: string | undefined) => {
  if (dbValue !== undefined && dbValue !== null && dbValue.length > 0) return dbValue;
  if (envValue !== undefined && envValue !== null && envValue.length > 0) return envValue;
  return undefined;
};

export const mergeDocumentRenderSettings = (
  env: DocumentRenderEnvBag,
  stored: PlatformDocumentRenderSettings & { revision: number },
): EffectiveDocumentRenderSettings => {
  const useDb = stored.enabled;
  const source: 'db' | 'env' = useDb ? 'db' : 'env';
  const storedField = <T>(value: T | undefined): T | undefined => (useDb ? value : undefined);
  const endpoint = pickOptional(storedField(stored.endpoint), env.DOCUMENT_RENDER_URL);

  return {
    concurrency: pick(
      storedField(stored.concurrency),
      env.DOCUMENT_RENDER_CONCURRENCY,
      DOCUMENT_RENDER_DEFAULTS.concurrency,
    ),
    contactSheetCols: pick(
      storedField(stored.contactSheetCols),
      undefined,
      DOCUMENT_RENDER_DEFAULTS.contactSheetCols,
    ),
    contactSheetRows: pick(
      storedField(stored.contactSheetRows),
      undefined,
      DOCUMENT_RENDER_DEFAULTS.contactSheetRows,
    ),
    ...(endpoint ? { endpoint } : {}),
    longEdgePx: pick(
      storedField(stored.longEdgePx),
      env.DOCUMENT_RENDER_LONG_EDGE_PX,
      DOCUMENT_RENDER_DEFAULTS.longEdgePx,
    ),
    maxDocsPerRequest: pick(
      storedField(stored.maxDocsPerRequest),
      undefined,
      DOCUMENT_RENDER_DEFAULTS.maxDocsPerRequest,
    ),
    maxFileBytes: pick(
      storedField(stored.maxFileBytes),
      env.DOCUMENT_RENDER_MAX_FILE_BYTES,
      DOCUMENT_RENDER_DEFAULTS.maxFileBytes,
    ),
    maxImagesDefault: pick(
      storedField(stored.maxImagesDefault),
      undefined,
      DOCUMENT_RENDER_DEFAULTS.maxImagesDefault,
    ),
    maxPages: pick(
      storedField(stored.maxPages),
      env.DOCUMENT_RENDER_MAX_PAGES,
      DOCUMENT_RENDER_DEFAULTS.maxPages,
    ),
    mediaThresholdT2: pick(
      storedField(stored.mediaThresholdT2),
      undefined,
      DOCUMENT_RENDER_DEFAULTS.mediaThresholdT2,
    ),
    pptxAlwaysT2: pick(
      storedField(stored.pptxAlwaysT2),
      undefined,
      DOCUMENT_RENDER_DEFAULTS.pptxAlwaysT2,
    ),
    retentionDays: pick(
      storedField(stored.retentionDays),
      undefined,
      DOCUMENT_RENDER_DEFAULTS.retentionDays,
    ),
    revision: stored.revision,
    source,
    thumbEdgePx: pick(
      storedField(stored.thumbEdgePx),
      env.DOCUMENT_RENDER_THUMB_EDGE_PX,
      DOCUMENT_RENDER_DEFAULTS.thumbEdgePx,
    ),
    tilesForDensePages: pick(
      storedField(stored.tilesForDensePages),
      undefined,
      DOCUMENT_RENDER_DEFAULTS.tilesForDensePages,
    ),
    timeoutSec: pick(
      storedField(stored.timeoutSec),
      env.DOCUMENT_RENDER_TIMEOUT_SEC,
      DOCUMENT_RENDER_DEFAULTS.timeoutSec,
    ),
    trigger: pick(
      storedField(stored.trigger),
      env.DOCUMENT_RENDER_TRIGGER,
      DOCUMENT_RENDER_DEFAULTS.trigger,
    ),
  };
};

export const settingsFromEnv = (override?: DocumentRenderEnvBag): EffectiveDocumentRenderSettings =>
  mergeDocumentRenderSettings(readDocumentRenderEnvBag(override), {
    ...normalizeDocumentRenderSettings({}),
    revision: 0,
  });

export const isDocumentRenderConfigured = (settings: EffectiveDocumentRenderSettings): boolean =>
  Boolean(settings.endpoint);

export const invalidateEffectiveDocumentRenderSettings = (): void => {
  cache = null;
};

export const resetEffectiveDocumentRenderSettingsForTest = (): void => {
  cache = null;
};

export interface GetEffectiveDocumentRenderSettingsOptions {
  db?: ConstructorParameters<typeof PlatformDocumentRenderSettingsModel>[0];
  env?: DocumentRenderEnvBag;
  now?: () => number;
}

/**
 * Cached effective document-render settings: each stored field overrides env (`DB ?? env`).
 * Invalidated on save. Fail-open to env when the database is unavailable.
 */
export const getEffectiveDocumentRenderSettings = async (
  options: GetEffectiveDocumentRenderSettingsOptions = {},
): Promise<EffectiveDocumentRenderSettings> => {
  const now = options.now?.() ?? Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.value;
  }

  const env = readDocumentRenderEnvBag(options.env);
  let stored: PlatformDocumentRenderSettings & { revision: number } = {
    ...normalizeDocumentRenderSettings({}),
    revision: 0,
  };
  try {
    const db = options.db ?? (await getServerDB());
    stored = await new PlatformDocumentRenderSettingsModel(db).get();
  } catch {
    // Fail open: a DB outage must not take document rendering down.
  }

  const value = mergeDocumentRenderSettings(env, stored);
  cache = { expiresAt: now + CACHE_TTL_MS, value };
  return value;
};
