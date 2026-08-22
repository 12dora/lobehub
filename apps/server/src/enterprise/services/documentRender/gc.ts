import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import debug from 'debug';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { PlatformJobModel } from '@/database/models/platform/job';
import { files } from '@/database/schemas';
import { platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import type { AdminSystemDocumentRenderMaintenance } from '@/server/enterprise/contracts/adminSystem';
import type { PlatformJobDispatchHandlerContext } from '@/server/enterprise/jobs/platformJobsDispatcher';
import { createFileS3 } from '@/server/modules/S3';
import { DOCUMENT_RENDER_GC_JOB_TYPE } from '@/types/files';

import { getEffectiveDocumentRenderSettings } from '../documentRenderSettings';
import { deleteDocumentRenderArtifacts } from './artifacts';
import { documentRenderTempRoot } from './queue';

const log = debug('lobe-server:document-render');

const RETENTION_BATCH = 500;
const FILE_LOOKUP_CHUNK = 500;
const S3_DELETE_CHUNK = 1000;
const TEMP_DIR_MAX_AGE_MS = 60 * 60 * 1000;
const RENDER_PREFIX = 'files/render/';

/**
 * ISO-8601 instant shape. `updatedAt` is client-writable file metadata, so the
 * retention query must not cast non-matching values to timestamptz.
 */
const RENDER_UPDATED_AT_ISO_RE = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$`;

const heartbeatIntervalMs = (leaseMs: number): number => Math.max(1, Math.floor(leaseMs / 3));

export class GcAbortedError extends Error {
  constructor(message = 'document render gc aborted') {
    super(message);
    this.name = 'GcAbortedError';
  }
}

const throwIfGcAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new GcAbortedError();
};

export type DocumentRenderGcResultSummary = {
  artifactBytes: number;
  artifactObjects: number;
  durationMs: number;
  expiredFiles: number;
  failedFiles?: number;
  orphanBytes: number;
  orphanObjects: number;
  ranAt: string;
  skipped?: boolean;
  tempDirBytes: number;
};

const asNonNegativeInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;

const asIso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
};

const emptyMaintenance = (): AdminSystemDocumentRenderMaintenance => ({
  artifactBytes: null,
  artifactObjects: null,
  expiredFiles: null,
  jobStatus: null,
  lastError: null,
  lastRunAt: null,
  orphanBytes: null,
  orphanObjects: null,
  tempDirBytes: null,
});

const fileIdFromRenderKey = (key: string): string | undefined => {
  if (!key.startsWith(RENDER_PREFIX)) return undefined;
  const rest = key.slice(RENDER_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return undefined;
  return rest.slice(0, slash);
};

const markRenderSkippedExpired = async (db: LobeChatDatabase, fileId: string): Promise<void> => {
  const patch = JSON.stringify({
    contactSheets: null,
    error: 'retention expired',
    figures: null,
    pages: null,
    pdf: null,
    renderedPages: null,
    status: 'skipped',
    textIndex: null,
    updatedAt: new Date().toISOString(),
  });
  await db
    .update(files)
    .set({
      metadata: sql`coalesce(${files.metadata}, '{}'::jsonb) || jsonb_build_object('render', coalesce(${files.metadata} -> 'render', '{}'::jsonb) || ${patch}::jsonb)`,
    })
    .where(eq(files.id, fileId));
};

const expireRetainedArtifacts = async (
  db: LobeChatDatabase,
  retentionDays: number,
  signal?: AbortSignal,
): Promise<{ expiredFiles: number; failedFiles: number }> => {
  if (retentionDays <= 0) return { expiredFiles: 0, failedFiles: 0 };

  const expired = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        inArray(sql<string>`${files.metadata} -> 'render' ->> 'status'`, ['partial', 'ready']),
        sql`${files.metadata} -> 'render' ->> 'updatedAt' is not null`,
        sql`(CASE WHEN (${files.metadata} -> 'render' ->> 'updatedAt') ~ ${RENDER_UPDATED_AT_ISO_RE} THEN (${files.metadata} -> 'render' ->> 'updatedAt')::timestamptz END) < now() - (${retentionDays}::int * interval '1 day')`,
      ),
    )
    .limit(RETENTION_BATCH);

  let expiredFiles = 0;
  let failedFiles = 0;
  for (const row of expired) {
    throwIfGcAborted(signal);
    try {
      await deleteDocumentRenderArtifacts([row.id]);
    } catch (error) {
      if (error instanceof GcAbortedError) throw error;
      console.error('Failed to delete document-render artifacts for retention', row.id, error);
      failedFiles += 1;
      continue;
    }
    await markRenderSkippedExpired(db, row.id);
    expiredFiles += 1;
  }
  return { expiredFiles, failedFiles };
};

const existingFileIds = async (db: LobeChatDatabase, ids: string[]): Promise<Set<string>> => {
  const found = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += FILE_LOOKUP_CHUNK) {
    const chunk = ids.slice(offset, offset + FILE_LOOKUP_CHUNK);
    if (chunk.length === 0) continue;
    const rows = await db.select({ id: files.id }).from(files).where(inArray(files.id, chunk));
    for (const row of rows) found.add(row.id);
  }
  return found;
};

const deleteObjectChunks = async (
  s3: { deleteFiles: (keys: string[]) => Promise<unknown> },
  objects: Array<{ key: string; size: number }>,
  signal?: AbortSignal,
): Promise<{ failedKeys: number; orphanBytes: number; orphanObjects: number }> => {
  let failedKeys = 0;
  let orphanBytes = 0;
  let orphanObjects = 0;
  for (let offset = 0; offset < objects.length; offset += S3_DELETE_CHUNK) {
    throwIfGcAborted(signal);
    const chunk = objects.slice(offset, offset + S3_DELETE_CHUNK);
    if (chunk.length === 0) continue;
    try {
      await s3.deleteFiles(chunk.map((object) => object.key));
    } catch (error) {
      if (error instanceof GcAbortedError) throw error;
      console.error('Failed to delete orphan document-render objects', error);
      failedKeys += chunk.length;
      continue;
    }
    for (const object of chunk) {
      orphanBytes += object.size;
      orphanObjects += 1;
    }
  }
  return { failedKeys, orphanBytes, orphanObjects };
};

const scanOrphans = async (
  db: LobeChatDatabase,
  s3: {
    deleteFiles: (keys: string[]) => Promise<unknown>;
    listObjectsByPrefix: (prefix: string) => Promise<Array<{ key: string; size: number }>>;
  },
  signal?: AbortSignal,
): Promise<{
  artifactBytes: number;
  artifactObjects: number;
  failedFiles: number;
  orphanBytes: number;
  orphanObjects: number;
}> => {
  const objects = await s3.listObjectsByPrefix(RENDER_PREFIX);
  throwIfGcAborted(signal);
  const byFileId = new Map<string, Array<{ key: string; size: number }>>();
  let totalBytes = 0;
  for (const object of objects) {
    totalBytes += object.size;
    const fileId = fileIdFromRenderKey(object.key);
    if (!fileId) continue;
    const group = byFileId.get(fileId);
    if (group) group.push(object);
    else byFileId.set(fileId, [object]);
  }

  const present = await existingFileIds(db, [...byFileId.keys()]);
  throwIfGcAborted(signal);
  const orphanObjectsList: Array<{ key: string; size: number }> = [];
  for (const [fileId, group] of byFileId) {
    if (present.has(fileId)) continue;
    orphanObjectsList.push(...group);
  }
  const deleted = await deleteObjectChunks(s3, orphanObjectsList, signal);

  return {
    artifactBytes: totalBytes - deleted.orphanBytes,
    artifactObjects: objects.length - deleted.orphanObjects,
    failedFiles: deleted.failedKeys,
    orphanBytes: deleted.orphanBytes,
    orphanObjects: deleted.orphanObjects,
  };
};

const directorySize = async (dir: string): Promise<number> => {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
};

const sweepTempDir = async (signal?: AbortSignal): Promise<number> => {
  throwIfGcAborted(signal);
  const root = documentRenderTempRoot();
  try {
    await stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }

  const now = Date.now();
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    throwIfGcAborted(signal);
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    const info = await stat(full);
    if (now - info.mtimeMs > TEMP_DIR_MAX_AGE_MS) {
      await rm(full, { force: true, recursive: true });
    }
  }
  return directorySize(root);
};

const zeros = (
  durationMs: number,
  ranAt: string,
  extra?: { skipped?: boolean; tempDirBytes?: number },
): DocumentRenderGcResultSummary => ({
  artifactBytes: 0,
  artifactObjects: 0,
  durationMs,
  expiredFiles: 0,
  orphanBytes: 0,
  orphanObjects: 0,
  ranAt,
  tempDirBytes: extra?.tempDirBytes ?? 0,
  ...(extra?.skipped ? { skipped: true } : {}),
});

const runDocumentRenderGcSweep = async (
  db: LobeChatDatabase,
  signal?: AbortSignal,
): Promise<DocumentRenderGcResultSummary> => {
  const started = Date.now();
  const ranAt = new Date(started).toISOString();

  let s3: Awaited<ReturnType<typeof createFileS3>>;
  try {
    s3 = await createFileS3();
  } catch {
    return zeros(Date.now() - started, ranAt, { skipped: true });
  }

  throwIfGcAborted(signal);
  const settings = await getEffectiveDocumentRenderSettings({ db });
  throwIfGcAborted(signal);
  const expired = await expireRetainedArtifacts(db, settings.retentionDays, signal);
  throwIfGcAborted(signal);
  const orphans = await scanOrphans(db, s3, signal);
  throwIfGcAborted(signal);
  let tempDirBytes = 0;
  try {
    tempDirBytes = await sweepTempDir(signal);
  } catch (error) {
    if (error instanceof GcAbortedError) throw error;
    console.error('Failed to sweep document-render temp dir', error);
  }

  const failedFiles = expired.failedFiles + orphans.failedFiles;
  return {
    artifactBytes: orphans.artifactBytes,
    artifactObjects: orphans.artifactObjects,
    durationMs: Date.now() - started,
    expiredFiles: expired.expiredFiles,
    ...(failedFiles > 0 ? { failedFiles } : {}),
    orphanBytes: orphans.orphanBytes,
    orphanObjects: orphans.orphanObjects,
    ranAt,
    tempDirBytes,
  };
};

/** Handle one already-claimed `platform.document.render.gc.v1` job. */
export const processClaimedDocumentRenderGcJob = async (
  ctx: PlatformJobDispatchHandlerContext,
): Promise<void> => {
  const jobs = new PlatformJobModel(ctx.db);
  const controller = new AbortController();
  const logLostOwnership = (action: 'complete' | 'fail') => {
    log('lost ownership on %s jobId=%s', action, ctx.job.id);
  };
  const intervalMs = heartbeatIntervalMs(ctx.spec.leaseMs);
  const heartbeatTimer = setInterval(() => {
    if (controller.signal.aborted) return;
    void jobs
      .heartbeat(ctx.job.id, ctx.workerId, ctx.spec.leaseMs)
      .then((row) => {
        if (!row) controller.abort();
      })
      .catch(() => {
        controller.abort();
      });
  }, intervalMs);

  try {
    const resultSummary = await runDocumentRenderGcSweep(ctx.db, controller.signal);
    const completed = await jobs.complete({
      jobId: ctx.job.id,
      resultSummary,
      workerId: ctx.workerId,
    });
    if (!completed) logLostOwnership('complete');
  } catch (error) {
    if (error instanceof GcAbortedError) {
      log('document render gc aborted jobId=%s: %s', ctx.job.id, error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('document render gc failed', error);
    const failed = await jobs.fail({
      error: { message },
      jobId: ctx.job.id,
      terminal: true,
      workerId: ctx.workerId,
    });
    if (!failed) logLostOwnership('fail');
  } finally {
    controller.abort();
    clearInterval(heartbeatTimer);
  }
};

/** Latest GC job of any status, for the admin status card. */
export const getDocumentRenderMaintenanceSummary = async (
  db: LobeChatDatabase,
): Promise<AdminSystemDocumentRenderMaintenance> => {
  const [row] = await db
    .select({
      createdAt: platformJobs.createdAt,
      finishedAt: platformJobs.finishedAt,
      lastError: platformJobs.lastError,
      resultSummary: platformJobs.resultSummary,
      startedAt: platformJobs.startedAt,
      status: platformJobs.status,
    })
    .from(platformJobs)
    .where(eq(platformJobs.type, DOCUMENT_RENDER_GC_JOB_TYPE))
    .orderBy(desc(platformJobs.createdAt))
    .limit(1);

  if (!row) return emptyMaintenance();

  const summary = row.resultSummary ?? {};
  const lastError =
    row.lastError && typeof row.lastError.message === 'string' ? row.lastError.message : null;

  return {
    artifactBytes: asNonNegativeInt(summary.artifactBytes),
    artifactObjects: asNonNegativeInt(summary.artifactObjects),
    expiredFiles: asNonNegativeInt(summary.expiredFiles),
    jobStatus: row.status,
    lastError,
    lastRunAt: asIso(row.finishedAt ?? row.startedAt ?? row.createdAt),
    orphanBytes: asNonNegativeInt(summary.orphanBytes),
    orphanObjects: asNonNegativeInt(summary.orphanObjects),
    tempDirBytes: asNonNegativeInt(summary.tempDirBytes),
  };
};
