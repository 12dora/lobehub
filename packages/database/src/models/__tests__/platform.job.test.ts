// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformJobs } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformJobModel } from '../platform/job';

const serverDB: LobeChatDatabase = await getTestDB();
const jobModel = new PlatformJobModel(serverDB);

afterEach(async () => {
  await serverDB.delete(platformJobs);
});

describe('PlatformJobModel', () => {
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
  });
});
