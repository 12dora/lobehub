import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, count, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import { PlatformJobModel } from '@/database/models/platform/job';
import { files } from '@/database/schemas';
import { platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import {
  DOCUMENT_RENDER_JOB_TYPE,
  documentRenderArtifactPrefix,
  readFileRenderMetadata,
} from '@/types/files';

import { isPersistentEnterpriseWorkerRuntime } from '../../jobs/persistentWorkerRuntime';
import {
  ensurePlatformJobsDispatcherStarted,
  wakePlatformJobsDispatcher,
} from '../../jobs/platformJobsDispatcher';
import { getEffectiveDocumentRenderSettings } from '../documentRenderSettings';
import { isRenderableDocumentKind, resolveDocumentKind } from './classify';

const JOB_MAX_ATTEMPTS = 3;
const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 10;

export const documentRenderTempRoot = (): string => path.join(tmpdir(), 'aihub-render');

export const clearDocumentRenderTempDir = async (): Promise<void> => {
  await rm(documentRenderTempRoot(), { force: true, recursive: true });
};

export const ensureDocumentRenderWorkerStarted = (): void => {
  if (!isPersistentEnterpriseWorkerRuntime()) return;
  void clearDocumentRenderTempDir().catch((error) => {
    console.error('Failed to clear document-render temp dir', error);
  });
  ensurePlatformJobsDispatcherStarted({ extraWorkerName: 'documentRender' });
};

export interface EnqueueDocumentRenderJobParams {
  fileId: string;
  force?: boolean;
  requestedBy?: string;
}

/**
 * Pull the dispatcher out of its idle backoff so the job starts now. The user
 * typically sends a message seconds after the upload; without this the first
 * turn sees `pending` for up to 60s.
 */
const markRenderPending = async (
  db: LobeChatDatabase,
  fileId: string,
  jobId: string,
): Promise<void> => {
  const patch = JSON.stringify({ jobId, status: 'pending', updatedAt: new Date().toISOString() });
  await db
    .update(files)
    .set({
      metadata: sql`coalesce(${files.metadata}, '{}'::jsonb) || jsonb_build_object('render', coalesce(${files.metadata} -> 'render', '{}'::jsonb) || ${patch}::jsonb)`,
    })
    .where(eq(files.id, fileId));
};

const wakeDispatcher = (): void => {
  try {
    wakePlatformJobsDispatcher();
  } catch {
    // best-effort: the next scheduled tick picks the job up anyway
  }
};

export const enqueueDocumentRenderJob = async (
  db: LobeChatDatabase,
  params: EnqueueDocumentRenderJobParams,
): Promise<{ created: boolean; jobId: string } | null> => {
  const result = await enqueueDocumentRenderJobRow(db, params);
  if (result) wakeDispatcher();
  return result;
};

const enqueueDocumentRenderJobRow = async (
  db: LobeChatDatabase,
  params: EnqueueDocumentRenderJobParams,
): Promise<{ created: boolean; jobId: string } | null> => {
  const file = await FileModel.getFileById(db, params.fileId);
  if (!file) return null;

  const kind = resolveDocumentKind(file.name, file.fileType);
  if (!isRenderableDocumentKind(kind)) return null;

  const settings = await getEffectiveDocumentRenderSettings({ db });
  if (settings.trigger === 'onDemand' && !params.force) return null;

  const jobs = new PlatformJobModel(db);
  const idempotencyKey = `document-render:${params.fileId}`;
  const { created, job } = await jobs.enqueue({
    idempotencyKey,
    input: { ext: extOf(file.name), fileId: params.fileId },
    maxAttempts: JOB_MAX_ATTEMPTS,
    requestedBy: params.requestedBy ?? null,
    type: DOCUMENT_RENDER_JOB_TYPE,
  });
  // Stamp `pending` now so a message sent seconds after the upload can wait
  // for the render instead of treating the file as never rendered.
  if (created) await markRenderPending(db, params.fileId, job.id);

  if (params.force && !created) {
    const render = readFileRenderMetadata(file.metadata);
    const skippedBySize =
      render?.status === 'skipped' &&
      typeof render.error === 'string' &&
      render.error.includes('maxFileBytes');
    const renderRetryable =
      render?.status === 'partial' || render?.status === 'failed' || skippedBySize;
    const jobRetryable =
      job.status === 'succeeded' || job.status === 'dead' || job.status === 'failed';
    if (jobRetryable && renderRetryable) {
      const [updated] = await db
        .update(platformJobs)
        .set({
          attempt: 0,
          finishedAt: null,
          lastError: null,
          leaseOwner: null,
          leaseUntil: null,
          startedAt: null,
          status: 'pending',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(platformJobs.type, DOCUMENT_RENDER_JOB_TYPE),
            eq(platformJobs.idempotencyKey, idempotencyKey),
            inArray(platformJobs.status, ['succeeded', 'dead', 'failed']),
          ),
        )
        .returning({ id: platformJobs.id });
      return { created: false, jobId: updated?.id ?? job.id };
    }
  }

  return { created, jobId: job.id };
};

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const percentile = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
};

export interface DocumentRenderQueueRecentItem {
  durationMs: number | null;
  error: string | null;
  ext: string;
  fileId: string;
  finishedAt: string | null;
  id: string;
  pages: number | null;
  status: string;
}

export interface DocumentRenderQueueStats {
  avgMs: number | null;
  failed24h: number;
  p95Ms: number | null;
  pending: number;
  recent: DocumentRenderQueueRecentItem[];
  running: number;
  succeeded24h: number;
}

const errorMessage = (lastError: Record<string, unknown> | null): string | null => {
  if (!lastError) return null;
  const message = lastError.message;
  if (typeof message === 'string' && message.length > 0) return message;
  const code = lastError.code;
  return typeof code === 'string' ? code : null;
};

export const getDocumentRenderQueueStats = async (
  db: LobeChatDatabase,
): Promise<DocumentRenderQueueStats> => {
  const since = new Date(Date.now() - STATS_WINDOW_MS);
  const typeEq = eq(platformJobs.type, DOCUMENT_RENDER_JOB_TYPE);

  const [pendingRow] = await db
    .select({ count: count() })
    .from(platformJobs)
    .where(and(typeEq, eq(platformJobs.status, 'pending')));
  const [runningRow] = await db
    .select({ count: count() })
    .from(platformJobs)
    .where(and(typeEq, eq(platformJobs.status, 'running')));
  const [failedRow] = await db
    .select({ count: count() })
    .from(platformJobs)
    .where(
      and(
        typeEq,
        inArray(platformJobs.status, ['failed', 'dead']),
        gte(platformJobs.finishedAt, since),
      ),
    );
  const succeeded = await db
    .select({
      durationMs: sql<number | null>`(${platformJobs.resultSummary}->>'durationMs')::int`,
      finishedAt: platformJobs.finishedAt,
      startedAt: platformJobs.startedAt,
    })
    .from(platformJobs)
    .where(and(typeEq, eq(platformJobs.status, 'succeeded'), gte(platformJobs.finishedAt, since)));

  const durations = succeeded
    .map((row) => {
      if (typeof row.durationMs === 'number' && Number.isFinite(row.durationMs))
        return row.durationMs;
      if (row.finishedAt && row.startedAt) {
        return new Date(row.finishedAt).getTime() - new Date(row.startedAt).getTime();
      }
      return null;
    })
    .filter((value): value is number => value !== null && value >= 0)
    .sort((a, b) => a - b);

  const recentRows = await db
    .select()
    .from(platformJobs)
    .where(typeEq)
    .orderBy(desc(platformJobs.createdAt))
    .limit(RECENT_LIMIT);

  const recent: DocumentRenderQueueRecentItem[] = recentRows.map((job) => {
    const input = job.input ?? {};
    const summary = job.resultSummary ?? {};
    return {
      durationMs: asNumber(summary.durationMs),
      error: errorMessage(job.lastError),
      ext: asString(input.ext) ?? asString(summary.ext) ?? '',
      fileId: asString(input.fileId) ?? '',
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      id: job.id,
      pages: asNumber(summary.pages),
      status: job.status,
    };
  });

  const avgMs =
    durations.length > 0
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : null;

  return {
    avgMs,
    failed24h: Number(failedRow?.count ?? 0),
    p95Ms: percentile(durations, 0.95),
    pending: Number(pendingRow?.count ?? 0),
    recent,
    running: Number(runningRow?.count ?? 0),
    succeeded24h: succeeded.length,
  };
};

export const retryDocumentRenderJob = async (
  db: LobeChatDatabase,
  jobId: string,
): Promise<{ ok: boolean }> => {
  const [row] = await db
    .update(platformJobs)
    .set({
      attempt: 0,
      finishedAt: null,
      lastError: null,
      leaseOwner: null,
      leaseUntil: null,
      startedAt: null,
      status: 'pending',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(platformJobs.id, jobId),
        eq(platformJobs.type, DOCUMENT_RENDER_JOB_TYPE),
        or(
          inArray(platformJobs.status, ['failed', 'dead']),
          and(
            eq(platformJobs.status, 'succeeded'),
            sql`${platformJobs.resultSummary}->>'status' = 'partial'`,
          ),
        ),
      ),
    )
    .returning({ id: platformJobs.id });
  return { ok: Boolean(row) };
};

export const cancelDocumentRenderJob = async (
  db: LobeChatDatabase,
  jobId: string,
): Promise<{ ok: boolean }> => {
  const jobs = new PlatformJobModel(db);
  const current = await jobs.findById(jobId);
  if (!current || current.type !== DOCUMENT_RENDER_JOB_TYPE) return { ok: false };
  const cancelled = await jobs.cancel(jobId);
  return { ok: Boolean(cancelled) };
};

export const cancelPendingDocumentRenderJobs = async (
  db: LobeChatDatabase,
  fileIds: string[],
): Promise<void> => {
  if (fileIds.length === 0) return;
  await db
    .update(platformJobs)
    .set({
      finishedAt: new Date(),
      leaseOwner: null,
      leaseUntil: null,
      status: 'cancelled',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(platformJobs.type, DOCUMENT_RENDER_JOB_TYPE),
        or(eq(platformJobs.status, 'pending'), eq(platformJobs.status, 'running')),
        inArray(sql<string>`${platformJobs.input}->>'fileId'`, fileIds),
      ),
    );
};

export const documentRenderPrefixFor = (fileId: string): string =>
  documentRenderArtifactPrefix(fileId);
