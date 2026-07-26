/**
 * True multi-connection PostgreSQL evidence for exact retention purge attribution (D5-03).
 *
 * Two workers finalize distinct purge intents for one run while a third connection
 * holds the run row. Both worker transactions must block on that row; after release,
 * their JSONB count increments must serialize to two rather than overwrite each other.
 *
 * @vitest-environment node
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  PlatformAuditExportModel,
  PlatformAuditRetentionRepository,
  PlatformAuditRetentionRunModel,
} from '@/database/models/platform';
import * as schema from '@/database/schemas';
import { platformAuditExports, platformAuditRetentionRuns } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { InMemoryAuditExportArtifactStorage } from './exportStorage';
import { deleteAuthorizedExportArtifacts } from './retentionWorkerArtifacts';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;

const asRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
};

const waitForBothWorkersBlockedBy = async (
  observeDb: LobeChatDatabase,
  params: {
    holderPid: number;
    workerApplications: readonly [string, string];
  },
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observeDb.execute(sql`
      SELECT
        count(*)::int AS waiting,
        count(*) FILTER (
          WHERE ${params.holderPid} = ANY(pg_blocking_pids(pid))
        )::int AS directly_blocked_by_holder
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name IN (
          ${params.workerApplications[0]},
          ${params.workerApplications[1]}
        )
        AND wait_event_type = 'Lock'
    `);
    const row = asRows<{ directly_blocked_by_holder?: number; waiting?: number }>(result)[0];
    if (Number(row?.waiting ?? 0) === 2 && Number(row?.directly_blocked_by_holder ?? 0) >= 1) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for both purge workers to block on the retention run row');
};

run('audit retention purge attribution — true multi-connection PostgreSQL', () => {
  const connectionString = process.env.DATABASE_TEST_URL!;
  const pools: Pool[] = [];
  let seedDb: LobeChatDatabase;
  let holderClient: PoolClient | undefined;
  let runId: string | undefined;
  const exportIds: string[] = [];

  const workerDb = (applicationName: string): LobeChatDatabase => {
    const pool = new Pool({
      application_name: applicationName,
      connectionString,
      max: 1,
    });
    pools.push(pool);
    return drizzle(pool, { schema }) as unknown as LobeChatDatabase;
  };

  beforeAll(async () => {
    seedDb = await getTestDB();
  });

  afterEach(async () => {
    if (holderClient) {
      await holderClient.query('ROLLBACK').catch(() => undefined);
      holderClient.release();
      holderClient = undefined;
    }
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    if (exportIds.length > 0) {
      await seedDb.delete(platformAuditExports).where(inArray(platformAuditExports.id, exportIds));
      exportIds.length = 0;
    }
    if (runId) {
      await seedDb
        .delete(platformAuditRetentionRuns)
        .where(eq(platformAuditRetentionRuns.id, runId));
      runId = undefined;
    }
  });

  afterAll(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it('atomically credits two concurrently finalized purge intents to one run', async () => {
    const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const workerApplications = [`audit-purge-a-${tag}`, `audit-purge-b-${tag}`] as const;
    const firstDb = workerDb(workerApplications[0]);
    const secondDb = workerDb(workerApplications[1]);
    const observerDb = workerDb(`audit-purge-observer-${tag}`);
    const holderPool = new Pool({ connectionString, max: 1 });
    pools.push(holderPool);

    const runModel = new PlatformAuditRetentionRunModel(seedDb);
    const retentionRun = await runModel.create({
      cutoffAt: new Date('2025-01-01T00:00:00.000Z'),
      mode: 'execute',
      policyRevision: 1,
      requestedBy: `audit-purge-admin-${tag}`,
      scope: 'export_artifacts',
    });
    runId = retentionRun.id;

    const storage = new InMemoryAuditExportArtifactStorage();
    const exportModel = new PlatformAuditExportModel(seedDb);
    for (const suffix of ['a', 'b']) {
      const exportId = `audit-purge-${suffix}-${tag}`;
      const storageKey = `platform-audit-exports/${exportId}/evidence.ndjson`;
      exportIds.push(exportId);
      storage.objects.set(storageKey, Buffer.from('{"type":"manifest"}\n'));
      await seedDb.insert(platformAuditExports).values({
        artifactBytes: 20,
        artifactChecksum: `sha256:${suffix.repeat(64)}`,
        expiresAt: new Date('2025-01-01T00:00:00.000Z'),
        finishedAt: new Date('2025-01-01T00:00:00.000Z'),
        id: exportId,
        includesMessageBodies: false,
        kind: 'operation_logs',
        requestedBy: `audit-purge-admin-${tag}`,
        rowCount: 1,
        status: 'completed',
        storageKey,
      });
      await exportModel.claimArtifactStorageForPurge(exportId, seedDb, retentionRun.id);
    }

    holderClient = await holderPool.connect();
    await holderClient.query('BEGIN');
    const holderPidResult = await holderClient.query<{ pid: number }>(
      'SELECT pg_backend_pid() pid',
    );
    const holderPid = holderPidResult.rows[0]!.pid;
    await holderClient.query(
      'SELECT id FROM platform_audit_retention_runs WHERE id = $1 FOR UPDATE',
      [retentionRun.id],
    );

    const firstFinalize = deleteAuthorizedExportArtifacts({
      ids: [exportIds[0]!],
      repo: new PlatformAuditRetentionRepository(firstDb),
      runId: retentionRun.id,
      storage,
    });
    const secondFinalize = deleteAuthorizedExportArtifacts({
      ids: [exportIds[1]!],
      repo: new PlatformAuditRetentionRepository(secondDb),
      runId: retentionRun.id,
      storage,
    });

    let waitError: unknown;
    try {
      await waitForBothWorkersBlockedBy(observerDb, {
        holderPid,
        workerApplications,
      });
    } catch (error) {
      waitError = error;
    } finally {
      await holderClient.query('COMMIT');
      holderClient.release();
      holderClient = undefined;
    }
    if (waitError) {
      await Promise.allSettled([firstFinalize, secondFinalize]);
      throw waitError;
    }

    await expect(Promise.all([firstFinalize, secondFinalize])).resolves.toEqual([
      { deleted: 1, skippedHold: 0 },
      { deleted: 1, skippedHold: 0 },
    ]);

    const completedRun = await runModel.get(retentionRun.id);
    expect(completedRun?.counts.exportArtifactsDeleted).toBe(2);
    expect(storage.objects.size).toBe(0);
    const pending = await new PlatformAuditExportModel(seedDb).listPendingArtifactPurges({
      limit: 200,
    });
    expect(pending.filter((item) => exportIds.includes(item.id))).toHaveLength(0);
  }, 30_000);
});
