// @vitest-environment node
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE,
  PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
  platformJobs,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformJobModel } from '../platform/job';

const serverDB: LobeChatDatabase = await getTestDB();
const jobModel = new PlatformJobModel(serverDB);

afterEach(async () => {
  await serverDB.delete(platformJobs);
});

describe('PlatformJobModel', () => {
  describe('admin operations projection', () => {
    it('uses a stable createdAt/id cursor and hides ledgers and raw payload columns', async () => {
      const createdAt = new Date('2026-07-20T00:00:00.000Z');
      await serverDB.insert(platformJobs).values([
        {
          createdAt,
          id: 'pjob_0000000000000003',
          idempotencyKey: 'admin-page-3',
          input: { control: { revision: 3 }, secret: 'never-return' },
          lastError: { message: 'private endpoint detail' },
          leaseOwner: 'private-worker',
          requestedBy: 'private-user',
          resultSummary: { failed: 2, private: 'never-return' },
          status: 'failed',
          type: 'platform.agent.rollout.v1',
        },
        {
          createdAt,
          id: 'pjob_0000000000000002',
          idempotencyKey: 'admin-page-2',
          input: { control: { revision: 2 } },
          status: 'running',
          type: 'platform.secret.rewrap.v1',
        },
        {
          createdAt,
          id: 'pjob_0000000000000001',
          idempotencyKey: 'admin-page-1',
          status: 'pending',
          type: 'connector.runtime.shared-call.v1',
        },
        {
          createdAt,
          id: 'pjob_0000000000000000',
          idempotencyKey: 'admin-ledger-hidden',
          status: 'failed',
          type: PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
        },
      ]);

      const first = await jobModel.listForAdmin({ limit: 2 });
      expect(first.items.map(({ id }) => id)).toEqual([
        'pjob_0000000000000003',
        'pjob_0000000000000002',
      ]);
      expect(first.nextCursor).toEqual({ createdAt, id: 'pjob_0000000000000002' });
      const second = await jobModel.listForAdmin({ cursor: first.nextCursor!, limit: 2 });
      expect(second.items.map(({ id }) => id)).toEqual(['pjob_0000000000000001']);
      expect(second.nextCursor).toBeNull();

      expect(first.items[0]).toMatchObject({ failedCount: 2, hasError: true, revision: 3 });
      const rawFields = [
        'cursor',
        'idempotencyKey',
        'input',
        'lastError',
        'leaseOwner',
        'requestedBy',
        'resultSummary',
      ];
      expect(Object.keys(first.items[0]!).filter((key) => rawFields.includes(key))).toEqual([]);
    });

    it('summarizes executable jobs without counting transition or failure ledgers', async () => {
      await serverDB.insert(platformJobs).values([
        ...(
          ['pending', 'reserved', 'running', 'succeeded', 'cancelled', 'failed', 'dead'] as const
        ).map((status, index) => ({
          idempotencyKey: `admin-summary-${index}`,
          status,
          type: 'platform.agent.rollout.v1',
        })),
        {
          idempotencyKey: 'admin-summary-ledger-1',
          status: 'failed',
          type: PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE,
        },
        {
          idempotencyKey: 'admin-summary-ledger-2',
          status: 'running',
          type: PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
        },
      ]);

      await expect(jobModel.getAdminSummary()).resolves.toEqual({
        active: 3,
        completed: 2,
        failed: 2,
        total: 7,
      });
    });
  });

  describe('operational backlog snapshot', () => {
    it('returns fixed zero-valued states with a database-authored clock when empty', async () => {
      const before = Date.now();
      const snapshot = await jobModel.getBacklogSnapshot();

      expect(snapshot.entries).toEqual([
        { count: 0, oldestAgeSeconds: 0, state: 'pending' },
        { count: 0, oldestAgeSeconds: 0, state: 'reserved_expired' },
        { count: 0, oldestAgeSeconds: 0, state: 'running_lease_expired' },
      ]);
      expect(snapshot.snapshotAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(snapshot.snapshotAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('counts only claimable or cleanable work and measures age from its availability clock', async () => {
      await serverDB.insert(platformJobs).values([
        {
          createdAt: sql`statement_timestamp() - interval '1 day'`,
          idempotencyKey: 'backlog-pending-old',
          status: 'pending',
          type: 'platform.agent.rollout.v1',
          updatedAt: sql`statement_timestamp() - interval '20 seconds'`,
        },
        {
          idempotencyKey: 'backlog-pending-new',
          status: 'pending',
          type: 'connector.runtime.shared-call.v1',
          updatedAt: sql`statement_timestamp() - interval '2 seconds'`,
        },
        {
          idempotencyKey: 'backlog-reserved-expired',
          leaseUntil: sql`statement_timestamp() - interval '12 seconds'`,
          status: 'reserved',
          type: 'connector.runtime.shared-call.v1',
        },
        {
          idempotencyKey: 'backlog-running-expired',
          leaseUntil: sql`statement_timestamp() - interval '7 seconds'`,
          status: 'running',
          type: 'platform.secret.rewrap.v1',
        },
        {
          idempotencyKey: 'backlog-reserved-active',
          leaseUntil: sql`statement_timestamp() + interval '1 minute'`,
          status: 'reserved',
          type: 'connector.runtime.shared-call.v1',
        },
        {
          idempotencyKey: 'backlog-running-active',
          leaseUntil: sql`statement_timestamp() + interval '1 minute'`,
          status: 'running',
          type: 'platform.agent.rollout.v1',
        },
        ...[PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE, PLATFORM_SECRET_REWRAP_FAILURE_TYPE].flatMap(
          (type, typeIndex) => [
            {
              idempotencyKey: `backlog-ledger-${typeIndex}-pending`,
              status: 'pending' as const,
              type,
              updatedAt: sql`statement_timestamp() - interval '2 days'`,
            },
            {
              idempotencyKey: `backlog-ledger-${typeIndex}-reserved`,
              leaseUntil: sql`statement_timestamp() - interval '2 days'`,
              status: 'reserved' as const,
              type,
            },
            {
              idempotencyKey: `backlog-ledger-${typeIndex}-running`,
              leaseUntil: sql`statement_timestamp() - interval '2 days'`,
              status: 'running' as const,
              type,
            },
          ],
        ),
        ...(['succeeded', 'dead', 'cancelled'] as const).map((status) => ({
          idempotencyKey: `backlog-terminal-${status}`,
          status,
          type: 'platform.agent.rollout.v1',
          updatedAt: sql`statement_timestamp() - interval '2 days'`,
        })),
      ]);

      const snapshot = await jobModel.getBacklogSnapshot();
      const byState = new Map(snapshot.entries.map((entry) => [entry.state, entry]));

      expect(byState.get('pending')?.count).toBe(2);
      expect(byState.get('pending')?.oldestAgeSeconds).toBeGreaterThanOrEqual(20);
      expect(byState.get('pending')?.oldestAgeSeconds).toBeLessThan(60);
      expect(byState.get('reserved_expired')?.count).toBe(1);
      expect(byState.get('reserved_expired')?.oldestAgeSeconds).toBeGreaterThanOrEqual(12);
      expect(byState.get('reserved_expired')?.oldestAgeSeconds).toBeLessThan(60);
      expect(byState.get('running_lease_expired')?.count).toBe(1);
      expect(byState.get('running_lease_expired')?.oldestAgeSeconds).toBeGreaterThanOrEqual(7);
      expect(byState.get('running_lease_expired')?.oldestAgeSeconds).toBeLessThan(60);
      expect(snapshot.entries.every(({ oldestAgeSeconds }) => oldestAgeSeconds >= 0)).toBe(true);
    });
  });

  describe('enqueue idempotency', () => {
    it('returns the same job for duplicate (type, idempotencyKey) without side effects', async () => {
      const first = await jobModel.enqueue({
        idempotencyKey: 'distribute:agent:agt_1',
        input: { agentId: 'agt_1' },
        type: 'agent.distribute',
      });
      expect(first.created).toBe(true);
      expect(first.job.status).toBe('pending');

      const second = await jobModel.enqueue({
        idempotencyKey: 'distribute:agent:agt_1',
        input: { agentId: 'agt_1', extra: true },
        type: 'agent.distribute',
      });
      expect(second.created).toBe(false);
      expect(second.job.id).toBe(first.job.id);
      // Original input is preserved — no re-execution / overwrite.
      expect(second.job.input).toEqual({ agentId: 'agt_1' });

      const all = await serverDB.query.platformJobs.findMany();
      expect(all).toHaveLength(1);
    });
  });

  describe('claim / lease / heartbeat', () => {
    it('claims a pending job and extends lease via heartbeat', async () => {
      const { job } = await jobModel.enqueue({
        idempotencyKey: 'k1',
        type: 'agent.distribute',
      });

      const claimed = await jobModel.claimNext({ leaseMs: 5_000, workerId: 'worker-a' });
      expect(claimed?.id).toBe(job.id);
      expect(claimed?.status).toBe('running');
      expect(claimed?.leaseOwner).toBe('worker-a');
      expect(claimed?.attempt).toBe(1);
      expect(claimed?.leaseUntil).toBeInstanceOf(Date);

      const beat = await jobModel.heartbeat(job.id, 'worker-a', 10_000);
      expect(beat?.leaseOwner).toBe('worker-a');
      expect(beat?.heartbeatAt).toBeInstanceOf(Date);

      // Another worker cannot heartbeat a job it does not own.
      const foreign = await jobModel.heartbeat(job.id, 'worker-b', 10_000);
      expect(foreign).toBeNull();
    });

    it('does not claim a job with an active lease held by another worker', async () => {
      await jobModel.enqueue({ idempotencyKey: 'k2', type: 'agent.distribute' });
      const claimed = await jobModel.claimNext({ leaseMs: 60_000, workerId: 'worker-a' });
      expect(claimed).toBeTruthy();

      const other = await jobModel.claimNext({ leaseMs: 60_000, workerId: 'worker-b' });
      expect(other).toBeNull();
    });

    it('allows reclaim after lease expiry (worker crash recovery)', async () => {
      const { job } = await jobModel.enqueue({
        idempotencyKey: 'k3',
        type: 'agent.distribute',
      });

      await jobModel.claimNext({ leaseMs: 1, workerId: 'worker-a' });

      // Force lease expiry in DB.
      await serverDB
        .update(platformJobs)
        .set({ leaseUntil: new Date(Date.now() - 1_000) })
        .where(eq(platformJobs.id, job.id));

      const reclaimed = await jobModel.claimNext({ leaseMs: 5_000, workerId: 'worker-b' });
      expect(reclaimed?.id).toBe(job.id);
      expect(reclaimed?.leaseOwner).toBe('worker-b');
      expect(reclaimed?.attempt).toBe(2);
      expect(reclaimed?.status).toBe('running');
    });
  });

  describe('claimBatch', () => {
    it('claims a mixed-type backlog in one call and leaves other types alone', async () => {
      const older = new Date('2026-08-01T00:00:00.000Z');
      const newer = new Date('2026-08-01T00:00:01.000Z');
      await jobModel.enqueue({
        idempotencyKey: 'batch-export',
        type: 'platform.audit.export.v1',
      });
      await jobModel.enqueue({
        idempotencyKey: 'batch-rollout',
        type: 'platform.agent.rollout.v1',
      });
      await jobModel.enqueue({
        idempotencyKey: 'batch-hidden',
        type: 'platform.secret.rewrap.v1',
      });
      await serverDB
        .update(platformJobs)
        .set({ createdAt: older })
        .where(eq(platformJobs.idempotencyKey, 'batch-export'));
      await serverDB
        .update(platformJobs)
        .set({ createdAt: newer })
        .where(eq(platformJobs.idempotencyKey, 'batch-rollout'));

      const claimed = await jobModel.claimBatch({
        leaseMsByType: {
          'platform.agent.rollout.v1': 60_000,
          'platform.audit.export.v1': 45_000,
        },
        limit: 10,
        types: ['platform.audit.export.v1', 'platform.agent.rollout.v1'],
        workerId: 'dispatcher-a',
      });

      expect(claimed.map((job) => job.type).sort()).toEqual([
        'platform.agent.rollout.v1',
        'platform.audit.export.v1',
      ]);
      expect(claimed.every((job) => job.status === 'running')).toBe(true);
      expect(claimed.every((job) => job.leaseOwner === 'dispatcher-a')).toBe(true);
      expect(claimed.every((job) => job.attempt === 1)).toBe(true);

      const exportJob = claimed.find((job) => job.type === 'platform.audit.export.v1')!;
      const rolloutJob = claimed.find((job) => job.type === 'platform.agent.rollout.v1')!;
      const exportLeaseMs =
        exportJob.leaseUntil!.getTime() - (exportJob.heartbeatAt ?? exportJob.startedAt)!.getTime();
      const rolloutLeaseMs =
        rolloutJob.leaseUntil!.getTime() -
        (rolloutJob.heartbeatAt ?? rolloutJob.startedAt)!.getTime();
      expect(exportLeaseMs).toBeLessThan(rolloutLeaseMs);

      const leftover = await jobModel.claimNext({
        types: ['platform.secret.rewrap.v1'],
        workerId: 'other',
      });
      expect(leftover?.idempotencyKey).toBe('batch-hidden');
    });

    it('returns [] when the type set is empty or the backlog is empty', async () => {
      await expect(jobModel.claimBatch({ types: [], workerId: 'dispatcher-a' })).resolves.toEqual(
        [],
      );
      await expect(
        jobModel.claimBatch({
          types: ['platform.audit.export.v1'],
          workerId: 'dispatcher-a',
        }),
      ).resolves.toEqual([]);
    });

    it('caps each type independently so a deep queue cannot starve another type', async () => {
      const older = new Date('2026-08-01T00:00:00.000Z');
      await serverDB.insert(platformJobs).values([
        ...[0, 1, 2, 3, 4].map((index) => ({
          createdAt: new Date(older.getTime() + index),
          idempotencyKey: `batch-cap-export-${index}`,
          status: 'pending' as const,
          type: 'platform.audit.export.v1',
        })),
        ...[0, 1].map((index) => ({
          createdAt: new Date(older.getTime() + 100 + index),
          idempotencyKey: `batch-cap-rollout-${index}`,
          status: 'pending' as const,
          type: 'platform.agent.rollout.v1',
        })),
      ]);

      const claimed = await jobModel.claimBatch({
        limitByType: {
          'platform.agent.rollout.v1': 2,
          'platform.audit.export.v1': 2,
        },
        types: ['platform.audit.export.v1', 'platform.agent.rollout.v1'],
        workerId: 'dispatcher-a',
      });

      const byType = claimed.reduce<Record<string, number>>((acc, job) => {
        acc[job.type] = (acc[job.type] ?? 0) + 1;
        return acc;
      }, {});
      expect(byType).toEqual({
        'platform.agent.rollout.v1': 2,
        'platform.audit.export.v1': 2,
      });

      const leftoverExport = await serverDB.query.platformJobs.findMany({
        where: and(
          eq(platformJobs.type, 'platform.audit.export.v1'),
          eq(platformJobs.status, 'pending'),
        ),
      });
      expect(leftoverExport).toHaveLength(3);
    });

    it('gives two sequential claimants distinct rows of the same type (PGlite cannot overlap two transactions)', async () => {
      await jobModel.enqueue({
        idempotencyKey: 'batch-conc-1',
        type: 'platform.audit.export.v1',
      });
      await jobModel.enqueue({
        idempotencyKey: 'batch-conc-2',
        type: 'platform.audit.export.v1',
      });

      const first = await jobModel.claimBatch({
        limitByType: { 'platform.audit.export.v1': 1 },
        types: ['platform.audit.export.v1'],
        workerId: 'worker-a',
      });
      const second = await jobModel.claimBatch({
        limitByType: { 'platform.audit.export.v1': 1 },
        types: ['platform.audit.export.v1'],
        workerId: 'worker-b',
      });

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(first[0]!.id).not.toBe(second[0]!.id);
      expect(new Set([first[0]!.leaseOwner, second[0]!.leaseOwner])).toEqual(
        new Set(['worker-a', 'worker-b']),
      );
    });

    it('releaseUnprocessed restores pending and undoes the claim attempt', async () => {
      const { job } = await jobModel.enqueue({
        idempotencyKey: 'batch-release',
        type: 'platform.audit.export.v1',
      });
      const [claimed] = await jobModel.claimBatch({
        types: ['platform.audit.export.v1'],
        workerId: 'dispatcher-a',
      });
      expect(claimed?.attempt).toBe(1);

      await expect(
        jobModel.releaseUnprocessed({ jobIds: [job.id], workerId: 'dispatcher-a' }),
      ).resolves.toBe(1);
      const row = await jobModel.findById(job.id);
      expect(row).toMatchObject({
        attempt: 0,
        leaseOwner: null,
        status: 'pending',
      });
    });

    it('dead-letters exhausted leases instead of reclaiming them in the batch', async () => {
      const { job } = await jobModel.enqueue({
        idempotencyKey: 'batch-dead',
        maxAttempts: 1,
        type: 'platform.audit.export.v1',
      });
      await jobModel.claimNext({ leaseMs: 5_000, workerId: 'worker-a' });
      await serverDB
        .update(platformJobs)
        .set({ leaseUntil: new Date(Date.now() - 1_000) })
        .where(eq(platformJobs.id, job.id));

      const claimed = await jobModel.claimBatch({
        types: ['platform.audit.export.v1'],
        workerId: 'dispatcher-a',
      });
      expect(claimed).toEqual([]);
      const row = await jobModel.findById(job.id);
      expect(row?.status).toBe('dead');
    });
  });

  describe('cursor checkpoint and completion', () => {
    it('persists cursor so a reclaimed worker can resume without redoing work', async () => {
      const sideEffects: string[] = [];
      const idempotencyKey = 'migrate:users:batch-1';

      const { job } = await jobModel.enqueue({
        idempotencyKey,
        input: { batch: 1 },
        type: 'migration.users',
      });

      const claimed = await jobModel.claimNext({ workerId: 'worker-a' });
      expect(claimed?.id).toBe(job.id);

      // Simulate partial progress.
      sideEffects.push('page-1');
      await jobModel.checkpoint({
        cursor: { page: 1, lastId: 'user_100' },
        jobId: job.id,
        progressDone: 100,
        progressTotal: 300,
        workerId: 'worker-a',
      });

      // Crash: expire lease.
      await serverDB
        .update(platformJobs)
        .set({ leaseUntil: new Date(Date.now() - 1_000) })
        .where(eq(platformJobs.id, job.id));

      const resumed = await jobModel.claimNext({ workerId: 'worker-b' });
      expect(resumed?.cursor).toEqual({ page: 1, lastId: 'user_100' });
      expect(resumed?.progressDone).toBe(100);

      // Resume from cursor — do not re-run page-1 side effect.
      const cursor = resumed?.cursor as { page: number };
      if (cursor.page < 2) {
        sideEffects.push('page-2');
      }
      await jobModel.checkpoint({
        cursor: { page: 2, lastId: 'user_200' },
        jobId: job.id,
        progressDone: 200,
        workerId: 'worker-b',
      });
      await jobModel.complete({
        jobId: job.id,
        resultSummary: { pages: 2 },
        workerId: 'worker-b',
      });

      expect(sideEffects).toEqual(['page-1', 'page-2']);

      // Idempotent re-enqueue of the same key must not create a new runnable job.
      const again = await jobModel.enqueue({
        idempotencyKey,
        type: 'migration.users',
      });
      expect(again.created).toBe(false);
      expect(again.job.status).toBe('succeeded');
      expect(again.job.id).toBe(job.id);
    });
  });

  describe('retry and dead letter', () => {
    it('requeues on fail until maxAttempts then moves to dead', async () => {
      const { job } = await jobModel.enqueue({
        idempotencyKey: 'retry-1',
        maxAttempts: 2,
        type: 'agent.distribute',
      });

      await jobModel.claimNext({ workerId: 'w1' });
      const failed = await jobModel.fail({
        error: { message: 'transient' },
        jobId: job.id,
        workerId: 'w1',
      });
      expect(failed?.status).toBe('pending');
      expect(failed?.lastError).toEqual({ message: 'transient' });

      await jobModel.claimNext({ workerId: 'w1' });
      const dead = await jobModel.fail({
        error: { message: 'still failing' },
        jobId: job.id,
        workerId: 'w1',
      });
      expect(dead?.status).toBe('dead');
      expect(dead?.attempt).toBe(2);
    });

    it('does not reclaim after crash once attempt budget is exhausted', async () => {
      const { job } = await jobModel.enqueue({
        idempotencyKey: 'crash-budget-1',
        maxAttempts: 1,
        type: 'agent.distribute',
      });

      const claimed = await jobModel.claimNext({ leaseMs: 5_000, workerId: 'worker-a' });
      expect(claimed?.id).toBe(job.id);
      expect(claimed?.attempt).toBe(1);
      expect(claimed?.status).toBe('running');

      // Uncaught crash: lease expires without fail()/complete().
      await serverDB
        .update(platformJobs)
        .set({ leaseUntil: new Date(Date.now() - 1_000) })
        .where(eq(platformJobs.id, job.id));

      const reclaimed = await jobModel.claimNext({ leaseMs: 5_000, workerId: 'worker-b' });
      expect(reclaimed).toBeNull();

      const row = await jobModel.findById(job.id);
      expect(row?.status).toBe('dead');
      expect(row?.attempt).toBe(1);
      expect(row?.leaseOwner).toBeNull();
      expect(row?.lastError).toMatchObject({
        code: 'MAX_ATTEMPTS_EXCEEDED',
        reason: 'lease_expired_after_attempt_budget',
      });
    });
  });
});
