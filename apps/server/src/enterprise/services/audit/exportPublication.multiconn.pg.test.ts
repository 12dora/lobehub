/**
 * TRUE multi-connection PostgreSQL evidence for audit export publication (F1 / F12).
 *
 * Publication (export row + job enqueue + required audit append) is one transaction.
 * Workers must not observe a claimable job until that TX commits; a rollback must leave
 * no claimable job and no success audit row.
 *
 * F12: two independent connections race AdminAuditExportService.create for the SAME
 * client mutation idempotency key (no pre-seed, no internal TX copies). Job enqueue
 * is idempotent on (type, idempotencyKey) and export.job_id is unique — exactly one
 * export + one job is committed; the other caller returns the same row (or would
 * reject). This locks create/publish dedup, not claim-dedup.
 *
 * Runs ONLY when `TEST_SERVER_DB=1` and `DATABASE_TEST_URL` is set; otherwise skipped.
 * PGlite is single-connection and cannot prove independent-session isolation.
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
import { platformAuditExports, platformAuditLogs, platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  buildAuditExportClientIdempotencyKey,
  PLATFORM_AUDIT_EXPORT_JOB_TYPE,
} from './exportConstants';
import { AdminAuditExportService, InMemoryAuditExportArtifactStorage } from './index';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;

const actor = 'audit-f1-multiconn-actor';
const window = {
  from: new Date('2026-03-01T00:00:00.000Z'),
  to: new Date('2026-03-10T00:00:00.000Z'),
};

run('audit export publication — true multi-connection PostgreSQL (F1/F12)', () => {
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
    await db.delete(platformJobs);
    await db.delete(users).where(eq(users.id, actor));
  };

  beforeAll(async () => {
    db = await getTestDB();
  });

  beforeEach(async () => {
    await cleanup();
    await db.insert(users).values({ id: actor });
  });

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    await cleanup();
  });

  afterAll(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it('claimNext cannot see the job until the publication TX commits', async () => {
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let insideHold = false;

    const publisher = new AdminAuditExportService(db, {
      afterEnqueue: async () => {
        // Job is enqueued inside the open TX; required audit has not run yet.
        insideHold = true;
        await hold;
      },
      storage,
    });

    const createPromise = publisher.create({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'f1 multiconn hold before audit',
        to: window.to,
      },
    });

    // Wait until the publisher is blocked inside the open transaction.
    for (let i = 0; i < 200 && !insideHold; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(insideHold).toBe(true);

    // Second independent connection — job must be invisible while TX is open.
    const claimerDb = workerDb();
    const claimer = new PlatformJobModel(claimerDb);
    const beforeCommit = await claimer.claimNext({
      leaseMs: 60_000,
      types: [PLATFORM_AUDIT_EXPORT_JOB_TYPE],
      workerId: 'f1-claimer-before-commit',
    });
    expect(beforeCommit).toBeNull();

    // No success audit row yet (append is after afterEnqueue).
    const midLogs = await claimerDb
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.exports.create'));
    expect(midLogs.filter((l) => l.result === 'success')).toHaveLength(0);

    releaseHold();
    const created = await createPromise;
    expect(created.jobId).toBeTruthy();

    // After commit, a fresh claimer observes exactly one job.
    const afterDb = workerDb();
    const afterClaimer = new PlatformJobModel(afterDb);
    const claimed = await afterClaimer.claimNext({
      leaseMs: 60_000,
      types: [PLATFORM_AUDIT_EXPORT_JOB_TYPE],
      workerId: 'f1-claimer-after-commit',
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(created.jobId);

    const successLogs = await db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.exports.create'));
    expect(successLogs.some((l) => l.result === 'success')).toBe(true);
  });

  it('rollback of the publication TX leaves no claimable job and no success audit', async () => {
    const publisher = new AdminAuditExportService(db, {
      afterEnqueue: async () => {
        throw new Error('INJECTED_AUDIT_APPEND_BLOCK');
      },
      storage,
    });

    await expect(
      publisher.create({
        actorPermissions: ['platform_audit:export:all'],
        actorUserId: actor,
        input: {
          from: window.from,
          includeMessageBodies: false,
          kind: 'operation_logs',
          reason: 'f1 multiconn rollback',
          to: window.to,
        },
      }),
    ).rejects.toThrow(/INJECTED_AUDIT_APPEND_BLOCK/);

    const claimerDb = workerDb();
    const claimer = new PlatformJobModel(claimerDb);
    const claimed = await claimer.claimNext({
      leaseMs: 60_000,
      types: [PLATFORM_AUDIT_EXPORT_JOB_TYPE],
      workerId: 'f1-claimer-after-rollback',
    });
    expect(claimed).toBeNull();

    expect(await db.select().from(platformJobs)).toHaveLength(0);
    expect(await db.select().from(platformAuditExports)).toHaveLength(0);

    // Failure path may write a non-required denied/failure audit outside the TX;
    // there must be no success publication audit for a rolled-back request.
    const logs = await db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.exports.create'));
    expect(logs.filter((l) => l.result === 'success')).toHaveLength(0);
  });

  it('F12: two connections concurrently create/publish the same logical key yield one export+job', async () => {
    // REAL concurrent create/publish race through AdminAuditExportService.create
    // (production entry point). No pre-seeded export, no copied internal TX steps.
    // Both callers use the SAME client mutation idempotency key. Exactly one export
    // + one job commit; the other returns the same row (dedup). Would FAIL if
    // publication-dedup were removed (both would mint their own export+job).
    const logicalKey = 'f12-concurrent-publication-key';
    const jobIdempotencyKey = buildAuditExportClientIdempotencyKey(actor, logicalKey);
    const createInput = {
      from: window.from,
      includeMessageBodies: false,
      kind: 'operation_logs' as const,
      reason: 'f12 concurrent same-key publication',
      to: window.to,
    };

    const publishViaCreate = async (conn: LobeChatDatabase) => {
      const publisher = new AdminAuditExportService(conn, { storage });
      return publisher.create({
        actorPermissions: ['platform_audit:export:all'],
        actorUserId: actor,
        idempotencyKey: logicalKey,
        input: createInput,
      });
    };

    const results = await Promise.allSettled([
      publishViaCreate(workerDb()),
      publishViaCreate(workerDb()),
    ]);

    // Service dedup returns the winning export to the concurrent loser, so both
    // callers fulfill with the same public projection (never a second export id).
    // A hard rejection is also acceptable only if the DB still has a single row.
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<AdminAuditExportService['create']>>> =>
        r.status === 'fulfilled',
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(results).toHaveLength(2);

    // Exactly ONE export + ONE job — never a second publication.
    const exportsAfter = await db.select().from(platformAuditExports);
    expect(exportsAfter).toHaveLength(1);
    const winner = exportsAfter[0]!;
    expect(winner.jobId).toBeTruthy();

    const jobsAfter = await db.select().from(platformJobs);
    expect(jobsAfter).toHaveLength(1);
    expect(jobsAfter[0]!.id).toBe(winner.jobId);
    expect(jobsAfter[0]!.idempotencyKey).toBe(jobIdempotencyKey);
    expect(jobsAfter[0]!.type).toBe(PLATFORM_AUDIT_EXPORT_JOB_TYPE);
    expect(jobsAfter[0]!.input).toEqual({ exportId: winner.id });

    for (const r of fulfilled) {
      expect(r.value.id).toBe(winner.id);
      expect(r.value.jobId).toBe(winner.jobId);
    }

    // Preferred path: both callers observe the same row (replay/dedup return).
    // If one rejected, the single-export/job asserts above still prove no double-publish.
    if (fulfilled.length === 2) {
      expect(fulfilled[0]!.value).toMatchObject({
        id: fulfilled[1]!.value.id,
        jobId: fulfilled[1]!.value.jobId,
      });
    }

    // At least one success audit for the winning publication.
    const successLogs = await db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.exports.create'));
    expect(successLogs.filter((l) => l.result === 'success').length).toBeGreaterThanOrEqual(1);
    expect(successLogs.filter((l) => l.result === 'success').map((l) => l.targetId)).toContain(
      winner.id,
    );
  });
});
