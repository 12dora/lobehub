import { getServerDB } from '@/database/core/db-adaptor';
import { PlatformDocumentRenderSettingsModel } from '@/database/models/platform/documentRenderSettings';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type { AdminSystemGetDocumentRenderSettings } from '@/server/enterprise/contracts/adminSystem';
import { isModuleEnabled } from '@/server/enterprise/services/moduleSettings';
import type { PlatformDocumentRenderSettings } from '@/types/platform/documentRenderSettings';
import { normalizeDocumentRenderSettings } from '@/types/platform/documentRenderSettings';

import type { DocumentRenderEnvBag, EffectiveDocumentRenderSettings } from './effective';
import {
  getEffectiveDocumentRenderSettings,
  mergeDocumentRenderSettings,
  readDocumentRenderEnvBag,
} from './effective';

export const DOCUMENT_RENDER_SETTINGS_AUDIT_ACTION = 'system.infra.document_render.update';
export const DOCUMENT_RENDER_SETTINGS_AUDIT_TARGET_TYPE = 'infra_settings';

/** Exact `admin.system.getDocumentRenderSettings` output shape. */
export type DocumentRenderSettingsView = AdminSystemGetDocumentRenderSettings;

export const toDocumentRenderSettingsOutput = (
  effective: EffectiveDocumentRenderSettings,
  stored: { enabled: boolean; revision: number },
  moduleEnabled: boolean,
): DocumentRenderSettingsView => ({
  config: {
    concurrency: effective.concurrency,
    contactSheetCols: effective.contactSheetCols,
    contactSheetRows: effective.contactSheetRows,
    endpoint: effective.endpoint ?? null,
    longEdgePx: effective.longEdgePx,
    maxDocsPerRequest: effective.maxDocsPerRequest,
    maxFileBytes: effective.maxFileBytes,
    maxImagesDefault: effective.maxImagesDefault,
    maxPages: effective.maxPages,
    mediaThresholdT2: effective.mediaThresholdT2,
    pptxAlwaysT2: effective.pptxAlwaysT2,
    retentionDays: effective.retentionDays,
    thumbEdgePx: effective.thumbEdgePx,
    tilesForDensePages: effective.tilesForDensePages,
    timeoutSec: effective.timeoutSec,
    trigger: effective.trigger,
  },
  enabled: stored.enabled,
  moduleEnabled,
  revision: stored.revision,
  source: effective.source,
});

export const getDocumentRenderSettingsView = async (options?: {
  db?: ConstructorParameters<typeof PlatformDocumentRenderSettingsModel>[0];
  env?: DocumentRenderEnvBag;
}): Promise<DocumentRenderSettingsView> => {
  const db = options?.db ?? (options?.env ? undefined : await getServerDB());
  const [effective, stored, moduleEnabled] = await Promise.all([
    getEffectiveDocumentRenderSettings({ db, env: options?.env }),
    db
      ? new PlatformDocumentRenderSettingsModel(db).get()
      : Promise.resolve({ ...normalizeDocumentRenderSettings({}), revision: 0 }),
    isModuleEnabled('documentRender'),
  ]);

  return toDocumentRenderSettingsOutput(effective, stored, moduleEnabled);
};

export const updateDocumentRenderSettings = async (
  db: LobeChatDatabase | Transaction,
  input: {
    actorId: string;
    config: PlatformDocumentRenderSettings;
    expectedRevision: number;
    reason?: string;
  },
): Promise<DocumentRenderSettingsView> => {
  const model = new PlatformDocumentRenderSettingsModel(db);
  const row = await model.update(input.actorId, {
    ...normalizeDocumentRenderSettings(input.config),
    expectedRevision: input.expectedRevision,
  });
  // The caller usually runs this inside a transaction that may still roll back
  // (audit insert). Build the response from the written row only; the cache is
  // invalidated by the router after commit.
  const effective = mergeDocumentRenderSettings(readDocumentRenderEnvBag(), row);
  const moduleEnabled = await isModuleEnabled('documentRender');
  return toDocumentRenderSettingsOutput(effective, row, moduleEnabled);
};

/** Redacted audit afterDiff — document-render settings contain no secrets. */
export const summarizeDocumentRenderAfterDiff = (config: PlatformDocumentRenderSettings) => ({
  concurrency: config.concurrency ?? null,
  contactSheetCols: config.contactSheetCols ?? null,
  contactSheetRows: config.contactSheetRows ?? null,
  enabled: config.enabled,
  endpoint: config.endpoint ?? null,
  longEdgePx: config.longEdgePx ?? null,
  maxDocsPerRequest: config.maxDocsPerRequest ?? null,
  maxFileBytes: config.maxFileBytes ?? null,
  maxImagesDefault: config.maxImagesDefault ?? null,
  maxPages: config.maxPages ?? null,
  mediaThresholdT2: config.mediaThresholdT2 ?? null,
  pptxAlwaysT2: config.pptxAlwaysT2 ?? null,
  retentionDays: config.retentionDays ?? null,
  thumbEdgePx: config.thumbEdgePx ?? null,
  tilesForDensePages: config.tilesForDensePages ?? null,
  timeoutSec: config.timeoutSec ?? null,
  trigger: config.trigger ?? null,
});
