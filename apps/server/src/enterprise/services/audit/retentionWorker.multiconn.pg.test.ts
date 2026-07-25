/**
 * TRUE multi-connection PostgreSQL evidence for audit retention lease races (F12).
 *
 * Slow object delete must renew the job lease between objects so a second worker
 * cannot double-claim while the first is still inside the actual delete path for
 * a work period longer than one lease window.
 *
 * Runs ONLY when `TEST_SERVER_DB=1` and `DATABASE_TEST_URL` is set; otherwise skipped.
 * PGlite is single-connection and cannot prove independent-session reclamation.
 *
 * @vitest-environment node
 */
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformJobModel } from '@/database/models/platform';
import * as schema from '@/database/schemas';
import { users } from '@/database/schemas';
import {
  platformAuditExports,
  platformAuditLogs,
  platformAuditPolicies,
  platformAuditRetentionRuns,
  platformJobs,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  AdminAuditRetentionService,
  InMemoryAuditExportArtifactStorage,
  processNextAuditRetentionJob,
} from './index';
import { PLATFORM_AUDIT_RETENTION_JOB_TYPE } from './retentionConstants';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;

const actor = 'audit-f12-retention-multiconn-actor';
const oldDate = new Date('2020-01-01T00:00:00.000Z');

run('audit retention lease — true multi-connection PostgreSQL (F12)', () => {
  const connectionString = process.env.DATABASE_TEST_URL!;
  const pools: Pool[] = [];
  let db: LobeChatDatabase;
  const storage = new InMemoryAuditExportArtifactStorage();

  const workerDb = (): LobeChatDatabase => {
    const pool = new Pool({ connectionString, max: 1 });
    pools.push(pool);
    return drizzle(pool, { schema }) as unknown as LobeChatDatabase;
  };

  const clearAuditLogs = async (target: LobeChatDatabase = db) => {
    await target.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
      await tx.delete(platformAuditLogs);
    });
  };

  const cleanup = async () => {
    storage.objects.clear();
    await clearAuditLogs();
    await db.delete(platformAuditExports);
    await db.delete(platformAuditRetentionRuns);
    await db.delete(platformJobs);
    await db.delete(platformAuditPolicies);
    await db.delete(users).where(eq(users.id, actor));
  };

  beforeAll(async () => {
    db = await getTestDB();
  });

  beforeEach(async () => {
    await cleanup();
    await db.insert(users).values({ id: actor });
    await db.insert(platformAuditPolicies).values({
      conversationRetentionDays: 30,
      exportArtifactRetentionDays: 7,
      id: 'global',
      operationLogRetentionDays: 30,
      revision: 1,
    });
  });

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    await cleanup();
  });

  afterAll(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it('slow delete inside object path across lease window — second worker cannot double-claim', async () => {
    // Three objects: each delete blocks for a large fraction of leaseMs.
    // Total wall time of the delete loop >> leaseMs. Per-object lease renew
    // (the slow-delete fix) must keep ownership so a second connection cannot
    // reclaim mid-flight. Blocking after claim under a fresh 120s lease would
    // pass even if that renew loop were removed — so we block in deleteObject.
    const leaseMs = 800;
    const deleteBlockMs = 450;
    const exportIds = ['export-f12-slow-a', 'export-f12-slow-b', 'export-f12-slow-c'] as const;

    for (const id of exportIds) {
      const storageKey = `platform-audit-exports/${id}/evidence.ndjson`;
      storage.objects.set(storageKey, Buffer.from(`{"type":"manifest","id":"${id}"}\n`));
      await db.insert(platformAuditExports).values({
        artifactBytes: 32,
        artifactChecksum: `sha256:slow-${id}`,
        createdAt: oldDate,
        expiresAt: oldDate,
        filterSnapshot: {},
        finishedAt: oldDate,
        id,
        includesMessageBodies: false,
        kind: 'operation_logs',
        requestedBy: actor,
        rowCount: 1,
        status: 'completed',
        storageKey,
      });
    }

    const service = new AdminAuditRetentionService(db, { storage });
    await service.run({
      actorUserId: actor,
      input: { reason: 'f12 slow multiconn lease', scope: 'export_artifacts' },
    });

    let inDelete = 0;
    let maxConcurrentDeletes = 0;
    const deleteEnteredAt: number[] = [];

    const slowStorage = {
      deleteObject: async (key: string) => {
        inDelete += 1;
        maxConcurrentDeletes = Math.max(maxConcurrentDeletes, inDelete);
        deleteEnteredAt.push(Date.now());
        try {
          // Block inside the ACTUAL delete (hold-lock TX open) — not after claim.
          await new Promise((r) => setTimeout(r, deleteBlockMs));
          storage.objects.delete(key);
        } finally {
          inDelete -= 1;
        }
      },
      getObjectMetadata: async (key: string) => {
        const body = storage.objects.get(key);
        if (!body) throw new Error(`Object not found: ${key}`);
        return { contentLength: body.byteLength, contentType: 'application/x-ndjson' };
      },
      getSignedDownloadUrl: async () => 'https://audit-export.test/signed/x',
      hashObject: async (key: string) => {
        const body = storage.objects.get(key);
        if (!body) throw new Error(`Object not found: ${key}`);
        return {
          artifactBytes: body.byteLength,
          artifactChecksum: `sha256:${'b'.repeat(64)}`,
        };
      },
      uploadArtifact: async () => {
        throw new Error('upload not used');
      },
    };

    const workerADb = workerDb();
    const workerBDb = workerDb();

    const workerA = processNextAuditRetentionJob(workerADb, {
      leaseMs,
      storage: slowStorage,
      workerId: 'ret-f12-slow-a',
    });

    // Wait until the first object delete is in progress.
    for (let i = 0; i < 200 && deleteEnteredAt.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(deleteEnteredAt.length).toBeGreaterThan(0);

    // While A is inside deletes for a span longer than one lease window, B must
    // never successfully reclaim the same retention job.
    const reclaimAttempts: Array<string | null> = [];
    const deadline = Date.now() + leaseMs + deleteBlockMs * exportIds.length + 2_000;
    while (Date.now() < deadline) {
      const jobsB = new PlatformJobModel(workerBDb);
      const stolen = await jobsB.claimNext({
        leaseMs,
        types: [PLATFORM_AUDIT_RETENTION_JOB_TYPE],
        workerId: 'ret-f12-slow-b',
      });
      reclaimAttempts.push(stolen?.id ?? null);
      if (stolen) break;
      // Also try full worker entry — must not claim.
      const bRun = await processNextAuditRetentionJob(workerBDb, {
        leaseMs,
        storage: slowStorage,
        workerId: 'ret-f12-slow-b2',
      });
      if (bRun.claimed) {
        reclaimAttempts.push(bRun.jobId ?? 'claimed');
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const aResult = await workerA;
    expect(aResult.claimed).toBe(true);
    expect(aResult.outcome).toBe('completed');

    // Total delete work spanned past a single lease window.
    expect(deleteEnteredAt.length).toBe(exportIds.length);
    const deleteSpanMs = deleteEnteredAt.at(-1)! - deleteEnteredAt[0]! + deleteBlockMs;
    expect(deleteSpanMs).toBeGreaterThan(leaseMs);

    // No successful reclamation while A owned the lease (renew between objects).
    expect(reclaimAttempts.every((id) => id == null)).toBe(true);
    expect(maxConcurrentDeletes).toBe(1);

    for (const id of exportIds) {
      expect(storage.objects.has(`platform-audit-exports/${id}/evidence.ndjson`)).toBe(false);
    }

    const [runRow] = await db
      .select()
      .from(platformAuditRetentionRuns)
      .where(eq(platformAuditRetentionRuns.id, aResult.runId!));
    expect(runRow?.counts?.exportArtifactsDeleted).toBe(exportIds.length);
  }, 30_000);
});
