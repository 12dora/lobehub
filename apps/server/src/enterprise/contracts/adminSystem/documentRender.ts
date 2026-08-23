import { z } from 'zod';

import { platformDocumentRenderSettingsSchema } from '@/types/platform/documentRenderSettings';

import { reasonSchema } from './common';

export const adminSystemDocumentRenderJobIdSchema = z.string().trim().min(1).max(128);

export const adminSystemDocumentRenderResolvedConfigSchema = z
  .object({
    concurrency: z.number().int().positive(),
    contactSheetCols: z.number().int().min(1).max(6),
    contactSheetRows: z.number().int().min(1).max(8),
    endpoint: z.string().trim().max(512).nullable(),
    longEdgePx: z.number().int().min(256).max(4096),
    maxDocsPerRequest: z.number().int().positive(),
    maxFileBytes: z.number().int().positive(),
    maxImagesDefault: z.number().int().positive(),
    maxPages: z.number().int().positive(),
    mediaThresholdT2: z.number().int().positive(),
    pptxAlwaysT2: z.boolean(),
    retentionDays: z.number().int().nonnegative(),
    thumbEdgePx: z.number().int().min(128).max(1024),
    tilesForDensePages: z.boolean(),
    timeoutSec: z.number().int().positive(),
    trigger: z.enum(['onDemand', 'onUpload']),
  })
  .strict();

export const adminSystemGetDocumentRenderSettingsOutputSchema = z
  .object({
    config: adminSystemDocumentRenderResolvedConfigSchema,
    enabled: z.boolean(),
    moduleEnabled: z.boolean(),
    revision: z.number().int().nonnegative(),
    source: z.enum(['db', 'env']),
  })
  .strict();

export const adminSystemUpdateDocumentRenderSettingsInputSchema = z
  .object({
    config: platformDocumentRenderSettingsSchema,
    expectedRevision: z.number().int().nonnegative(),
    reason: reasonSchema.optional(),
  })
  .strict();

export const adminSystemUpdateDocumentRenderSettingsOutputSchema =
  adminSystemGetDocumentRenderSettingsOutputSchema;

export const adminSystemDocumentRenderQueueRecentSchema = z
  .object({
    durationMs: z.number().int().nonnegative().nullable(),
    error: z.string().nullable(),
    ext: z.string(),
    fileId: z.string(),
    finishedAt: z.string().nullable(),
    id: z.string(),
    pages: z.number().int().nonnegative().nullable(),
    status: z.string(),
  })
  .strict();

/**
 * Per-process feed counters (since process start). Reset on restart; the
 * status page labels them accordingly.
 */
export const adminSystemDocumentRenderFeedStatsSchema = z
  .object({
    /** Requests where a document was still `pending` and the feed fell back to text. */
    pendingFallbacks: z.number().int().nonnegative(),
    /** Requests where the feed waited for a fresh pending render. */
    pendingWaits: z.number().int().nonnegative(),
    /** Documents that contributed at least one stored image. */
    docsFed: z.number().int().nonnegative(),
    /** Stored images (contact sheets + pages + tiles) attached to requests. */
    imagesFed: z.number().int().nonnegative(),
    /** Requests that attached at least one stored image. */
    requestsWithImages: z.number().int().nonnegative(),
    /** ISO timestamp of the counter epoch (process start). */
    since: z.string(),
    /** `viewDocumentPages` tool calls served with images. */
    toolPageViews: z.number().int().nonnegative(),
  })
  .strict();

/** Summary of the last completed `platform.document.render.gc.v1` job. */
export const adminSystemDocumentRenderMaintenanceSchema = z
  .object({
    /** Total objects / bytes under `files/render/` after the last sweep. */
    artifactBytes: z.number().int().nonnegative().nullable(),
    artifactObjects: z.number().int().nonnegative().nullable(),
    /** Files whose artifacts were removed because `retentionDays` elapsed. */
    expiredFiles: z.number().int().nonnegative().nullable(),
    /** Last GC job status (`succeeded` / `failed` / `dead` / `running` / `pending`) or null when never run. */
    jobStatus: z.string().nullable(),
    lastError: z.string().nullable(),
    lastRunAt: z.string().nullable(),
    /** Orphan objects (no owning `files` row) deleted by the last sweep. */
    orphanBytes: z.number().int().nonnegative().nullable(),
    orphanObjects: z.number().int().nonnegative().nullable(),
    /** Bytes currently under the worker temp dir (`os.tmpdir()/aihub-render`). */
    tempDirBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const adminSystemRunDocumentRenderGcInputSchema = z.object({}).strict();
export const adminSystemRunDocumentRenderGcOutputSchema = z
  .object({ jobId: z.string().nullable(), ok: z.boolean() })
  .strict();

export const adminSystemGetDocumentRenderStatusOutputSchema = z
  .object({
    configured: z.boolean(),
    feed: adminSystemDocumentRenderFeedStatsSchema,
    maintenance: adminSystemDocumentRenderMaintenanceSchema,
    moduleEnabled: z.boolean(),
    queue: z
      .object({
        avgMs: z.number().nullable(),
        failed24h: z.number().int().nonnegative(),
        p95Ms: z.number().nullable(),
        pending: z.number().int().nonnegative(),
        recent: z.array(adminSystemDocumentRenderQueueRecentSchema).max(20),
        running: z.number().int().nonnegative(),
        succeeded24h: z.number().int().nonnegative(),
      })
      .strict(),
    sidecar: z
      .object({
        checkedAt: z.string(),
        error: z.string().optional(),
        latencyMs: z.number().int().nonnegative().optional(),
        status: z.enum(['disabled', 'down', 'unconfigured', 'up']),
        version: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export const adminSystemRetryDocumentRenderJobInputSchema = z
  .object({ jobId: adminSystemDocumentRenderJobIdSchema })
  .strict();
export const adminSystemRetryDocumentRenderJobOutputSchema = z.object({ ok: z.boolean() }).strict();

export const adminSystemCancelDocumentRenderJobInputSchema = z
  .object({ jobId: adminSystemDocumentRenderJobIdSchema })
  .strict();
export const adminSystemCancelDocumentRenderJobOutputSchema = z
  .object({ ok: z.boolean() })
  .strict();

export type AdminSystemGetDocumentRenderSettings = z.infer<
  typeof adminSystemGetDocumentRenderSettingsOutputSchema
>;
export type AdminSystemGetDocumentRenderSettingsOutput = AdminSystemGetDocumentRenderSettings;
export type AdminSystemUpdateDocumentRenderSettingsInput = z.input<
  typeof adminSystemUpdateDocumentRenderSettingsInputSchema
>;
export type AdminSystemUpdateDocumentRenderSettingsOutput = z.infer<
  typeof adminSystemUpdateDocumentRenderSettingsOutputSchema
>;
export type AdminSystemGetDocumentRenderStatus = z.infer<
  typeof adminSystemGetDocumentRenderStatusOutputSchema
>;
export type AdminSystemGetDocumentRenderStatusOutput = AdminSystemGetDocumentRenderStatus;
export type AdminSystemDocumentRenderFeedStats = z.infer<
  typeof adminSystemDocumentRenderFeedStatsSchema
>;
export type AdminSystemDocumentRenderMaintenance = z.infer<
  typeof adminSystemDocumentRenderMaintenanceSchema
>;
export type AdminSystemRunDocumentRenderGcOutput = z.infer<
  typeof adminSystemRunDocumentRenderGcOutputSchema
>;
