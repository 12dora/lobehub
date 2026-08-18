import debug from 'debug';

import { PlatformJobModel } from '@/database/models/platform/job';
import type { PlatformJobItem } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { ConnectorCatalogSecretStore, ConnectorSecretSlot } from './catalogTypes';

const log = debug('lobe-server:connector-secret-cleanup');

const SECRET_REVOKE_TIMEOUT_MS = 1000;
const SECRET_REVOKE_CONCURRENCY = 8;
/** Durable exact-reference cleanup queue (platform_jobs). */
export const CONNECTOR_SECRET_CLEANUP_JOB_TYPE = 'connector.secret.cleanup.v1';
const CLEANUP_MAX_ATTEMPTS = 12;
/**
 * Orphan GC scans `platform_connector_secrets` without a leading index on the
 * filter columns. Throttle independent of the claim poll so a 5s worker tick
 * does not re-scan on every idle pass (~17k scans/day/process).
 */
const ORPHAN_GC_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastOrphanGcAtMs = 0;

/** Test-only: reset GC throttle so suite cases can force a scan. */
export const __resetConnectorSecretCleanupGcThrottleForTests = (): void => {
  lastOrphanGcAtMs = 0;
};

export interface ConnectorSecretCleanupRef {
  connectorId: string;
  ref: string;
  slot: ConnectorSecretSlot;
}

const cleanupKey = (cleanup: ConnectorSecretCleanupRef): string =>
  `${cleanup.connectorId}:${cleanup.slot}:${cleanup.ref}`;

const isCleanupRef = (value: unknown): value is ConnectorSecretCleanupRef => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.connectorId === 'string' &&
    typeof record.ref === 'string' &&
    typeof record.slot === 'string'
  );
};

/**
 * Persist an exact secret cleanup job so a later reconciler can revoke the
 * reference even after process restart (and without waiting on orphan grace).
 */
export const enqueueConnectorSecretCleanup = async (
  db: LobeChatDatabase,
  cleanup: ConnectorSecretCleanupRef,
): Promise<void> => {
  await new PlatformJobModel(db).enqueue({
    idempotencyKey: cleanupKey(cleanup),
    input: {
      connectorId: cleanup.connectorId,
      ref: cleanup.ref,
      slot: cleanup.slot,
    },
    maxAttempts: CLEANUP_MAX_ATTEMPTS,
    type: CONNECTOR_SECRET_CLEANUP_JOB_TYPE,
  });
};

const revokeOne = async (
  secrets: ConnectorCatalogSecretStore,
  cleanup: ConnectorSecretCleanupRef,
): Promise<boolean> => {
  if (!secrets.revokeSecretRef) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      secrets.revokeSecretRef(cleanup),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('secret revoke timeout')),
          SECRET_REVOKE_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch (error) {
    log(
      'best-effort revoke failed errorClass=%s slot=%s',
      error instanceof Error ? error.name : 'UnknownError',
      cleanup.slot,
    );
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** DB references must already be detached before this bounded cleanup runs. */
export const cleanupConnectorSecretRefs = async (
  secrets: ConnectorCatalogSecretStore,
  refs: ConnectorSecretCleanupRef[],
  options?: { db?: LobeChatDatabase },
): Promise<void> => {
  const deduplicated = [
    ...new Map(refs.map((item) => [`${item.connectorId}:${item.slot}:${item.ref}`, item])).values(),
  ];
  let cursor = 0;
  const failed: ConnectorSecretCleanupRef[] = [];
  const workers = Array.from(
    { length: Math.min(SECRET_REVOKE_CONCURRENCY, deduplicated.length) },
    async () => {
      while (cursor < deduplicated.length) {
        const index = cursor;
        cursor += 1;
        const cleanup = deduplicated[index];
        if (!cleanup) continue;
        const ok = await revokeOne(secrets, cleanup);
        if (!ok) failed.push(cleanup);
      }
    },
  );
  await Promise.all(workers);

  // Durable exact-ref retry: enqueue each failed cleanup so a reconciler can
  // replay the same connector/slot/ref after restart (process-local sets cannot).
  if (failed.length > 0 && options?.db) {
    await Promise.all(
      failed.map(async (cleanup) => {
        try {
          await enqueueConnectorSecretCleanup(options.db!, cleanup);
        } catch (error) {
          log(
            'enqueue cleanup job failed errorClass=%s',
            error instanceof Error ? error.name : 'UnknownError',
          );
        }
      }),
    );
  }

  // Opportunistic aged-orphan GC still helps when jobs are not yet drained.
  if (failed.length > 0 && secrets.garbageCollectOrphanedSecrets) {
    try {
      await secrets.garbageCollectOrphanedSecrets();
    } catch (error) {
      log(
        'deferred GC after failed revoke errorClass=%s',
        error instanceof Error ? error.name : 'UnknownError',
      );
    }
  }
};

/**
 * Handle one already-claimed `connector.secret.cleanup.v1` job. `retry` means
 * the revoke failed and the job was requeued — callers should stop the batch
 * so a short secret-service outage cannot burn `maxAttempts` in one tick.
 */
export const settleClaimedConnectorSecretCleanup = async (
  db: LobeChatDatabase,
  job: PlatformJobItem,
  secrets: ConnectorCatalogSecretStore,
  workerId: string,
): Promise<'completed' | 'failed' | 'retry'> => {
  const jobs = new PlatformJobModel(db);
  const cleanup = isCleanupRef(job.input) ? job.input : null;
  if (!cleanup) {
    await jobs.fail({
      error: { code: 'CONNECTOR_SECRET_CLEANUP_INVALID_INPUT' },
      jobId: job.id,
      terminal: true,
      workerId,
    });
    return 'failed';
  }

  const ok = await revokeOne(secrets, cleanup);
  if (ok) {
    await jobs.complete({ jobId: job.id, resultSummary: { ref: cleanup.ref }, workerId });
    return 'completed';
  }
  await jobs.fail({
    error: { code: 'CONNECTOR_SECRET_CLEANUP_REVOKE_FAILED' },
    jobId: job.id,
    workerId,
  });
  return 'retry';
};

/** Throttled aged-orphan GC. Safe to call from the merged dispatcher after a tick. */
export const maybeRunConnectorSecretOrphanGc = async (
  secrets: ConnectorCatalogSecretStore,
): Promise<boolean> => {
  const nowMs = Date.now();
  if (
    !secrets.garbageCollectOrphanedSecrets ||
    nowMs - lastOrphanGcAtMs < ORPHAN_GC_MIN_INTERVAL_MS
  ) {
    return false;
  }
  lastOrphanGcAtMs = nowMs;
  try {
    await secrets.garbageCollectOrphanedSecrets();
    return true;
  } catch (error) {
    log('reconcile GC failed errorClass=%s', error instanceof Error ? error.name : 'UnknownError');
    return false;
  }
};

/**
 * Drain durable cleanup jobs (exact ref revoke, no grace window) and run aged
 * orphan GC (throttled). Safe to call from workers or after archive/disconnect paths.
 */
export const reconcileConnectorSecretCleanups = async (
  db: LobeChatDatabase,
  secrets: ConnectorCatalogSecretStore,
  options: { limit?: number; workerId?: string } = {},
): Promise<{ completed: number; failed: number }> => {
  const jobs = new PlatformJobModel(db);
  const workerId = options.workerId ?? `connector-secret-cleanup:${process.pid}`;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  let completed = 0;
  let failed = 0;

  for (let i = 0; i < limit; i += 1) {
    const job = await jobs.claimNext({
      types: [CONNECTOR_SECRET_CLEANUP_JOB_TYPE],
      workerId,
    });
    if (!job) break;

    const outcome = await settleClaimedConnectorSecretCleanup(db, job, secrets, workerId);
    if (outcome === 'completed') completed += 1;
    else failed += 1;
    if (outcome === 'retry') break;
  }

  await maybeRunConnectorSecretOrphanGc(secrets);

  return { completed, failed };
};
