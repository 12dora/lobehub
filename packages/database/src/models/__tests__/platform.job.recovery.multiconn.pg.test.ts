/**
 * True multi-connection PostgreSQL evidence for platform job crash recovery.
 *
 * Three one-connection pools model independent workers. The suite owns a random schema, waits for
 * leases to expire naturally on PostgreSQL's clock, and drops the schema even when an assertion
 * fails. It never uses the shared phase-0 tables or writes job payloads to test output.
 *
 * @vitest-environment node
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { PlatformJobModel } from '../platform/job';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;
const schemaName = `platform_job_recovery_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const quotedSchemaName = `"${schemaName}"`;
const testJobType = `platform.job.recovery.drill.${randomUUID()}`;

interface Worker {
  db: LobeChatDatabase;
  pool: Pool;
}

run('PlatformJobModel crash recovery — three real PostgreSQL connections', () => {
  const connectionString = process.env.DATABASE_TEST_URL!;
  const adminPool = new Pool({ connectionString, max: 1 });
  const activeWorkerPools = new Set<Pool>();
  let schemaCreated = false;

  const createWorker = (): Worker => {
    const pool = new Pool({
      connectionString,
      max: 1,
      options: `-c search_path=${schemaName},public`,
    });
    activeWorkerPools.add(pool);
    return {
      db: drizzle(pool, { schema }) as unknown as LobeChatDatabase,
      pool,
    };
  };

  const stopWorker = async (worker: Worker) => {
    if (!activeWorkerPools.delete(worker.pool)) return;
    await worker.pool.end();
  };

  const applyIdempotentSideEffect = async (pool: Pool, jobId: string, itemKey: string) => {
    const result = await pool.query<{ item_key: string }>(
      `
        INSERT INTO platform_job_recovery_effects (job_id, item_key)
        VALUES ($1, $2)
        ON CONFLICT (job_id, item_key) DO NOTHING
        RETURNING item_key
      `,
      [jobId, itemKey],
    );
    return result.rowCount === 1;
  };

  const withNodeClock = async <T>(now: string, callback: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    try {
      return await callback();
    } finally {
      vi.useRealTimers();
    }
  };

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
    schemaCreated = true;
    await adminPool.query(`
      CREATE TABLE ${quotedSchemaName}.platform_jobs (
        id text PRIMARY KEY NOT NULL,
        type varchar(128) NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'pending',
        idempotency_key text NOT NULL,
        input jsonb NOT NULL DEFAULT '{}'::jsonb,
        progress_total integer,
        progress_done integer NOT NULL DEFAULT 0,
        cursor jsonb,
        result_summary jsonb,
        last_error jsonb,
        attempt integer NOT NULL DEFAULT 0,
        max_attempts integer,
        lease_owner text,
        lease_until timestamptz,
        heartbeat_at timestamptz,
        requested_by text,
        started_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (type, idempotency_key)
      )
    `);
    await adminPool.query(`
      CREATE TABLE ${quotedSchemaName}.platform_job_recovery_effects (
        job_id text NOT NULL,
        item_key text NOT NULL,
        PRIMARY KEY (job_id, item_key)
      )
    `);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await Promise.all([...activeWorkerPools].map((pool) => pool.end()));
    activeWorkerPools.clear();
    let schemaExists = false;
    if (schemaCreated) {
      await adminPool.query(`DROP SCHEMA ${quotedSchemaName} CASCADE`);
      const cleanup = await adminPool.query<{ schema_exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS schema_exists',
        [schemaName],
      );
      schemaExists = Boolean(cleanup.rows[0]?.schema_exists);
    }
    await adminPool.end();
    if (schemaExists) {
      throw new Error('Platform job recovery test schema cleanup failed');
    }
  });

  it('recovers a checkpointed backlog after a worker exits without duplicate effects', async () => {
    const workerA = createWorker();
    const workerB = createWorker();
    const workerC = createWorker();
    const jobsA = new PlatformJobModel(workerA.db);
    const jobsB = new PlatformJobModel(workerB.db);
    const jobsC = new PlatformJobModel(workerC.db);
    const leaseMs = 500;

    const { job } = await jobsA.enqueue({
      idempotencyKey: 'crash-recovery-main',
      input: { control: { revision: 17 } },
      progressTotal: 3,
      type: testJobType,
    });

    const claimedByA = await withNodeClock('2099-01-01T00:00:00.000Z', () =>
      jobsA.claimNext({ leaseMs, types: [testJobType], workerId: 'worker-a' }),
    );
    expect(claimedByA).toMatchObject({ attempt: 1, id: job.id, leaseOwner: 'worker-a' });
    expect(await applyIdempotentSideEffect(workerA.pool, job.id, 'item-1')).toBe(true);

    const checkpointedByA = await withNodeClock('2000-01-01T00:00:00.000Z', () =>
      jobsA.checkpoint({
        cursor: { nextItem: 2 },
        jobId: job.id,
        leaseMs,
        progressDone: 1,
        progressTotal: 3,
        workerId: 'worker-a',
      }),
    );
    expect(checkpointedByA).toMatchObject({ cursor: { nextItem: 2 }, progressDone: 1 });

    const liveLeaseClaims = await Promise.all([
      jobsB.claimNext({ leaseMs, types: [testJobType], workerId: 'worker-b' }),
      jobsC.claimNext({ leaseMs, types: [testJobType], workerId: 'worker-c' }),
    ]);
    expect(liveLeaseClaims).toEqual([null, null]);

    await stopWorker(workerA);
    await delay(leaseMs + 250);

    const stalled = await jobsB.getBacklogSnapshot();
    expect(stalled.entries.find(({ state }) => state === 'running_lease_expired')?.count).toBe(1);
    await expect(
      jobsB.checkpoint({ jobId: job.id, progressDone: 999, workerId: 'worker-a' }),
    ).resolves.toBeNull();
    await expect(jobsB.complete({ jobId: job.id, workerId: 'worker-a' })).resolves.toBeNull();
    await expect(
      jobsB.fail({ error: { category: 'late-worker' }, jobId: job.id, workerId: 'worker-a' }),
    ).resolves.toBeNull();

    const recoveryClaims = await Promise.all([
      jobsB.claimNext({ leaseMs: 2_000, types: [testJobType], workerId: 'worker-b' }),
      jobsC.claimNext({ leaseMs: 2_000, types: [testJobType], workerId: 'worker-c' }),
    ]);
    const winners = recoveryClaims.filter((claimed) => claimed !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      attempt: 2,
      cursor: { nextItem: 2 },
      id: job.id,
      progressDone: 1,
    });

    const winningWorker = recoveryClaims[0] ? workerB : workerC;
    const winningJobs = recoveryClaims[0] ? jobsB : jobsC;
    const winningWorkerId = recoveryClaims[0] ? 'worker-b' : 'worker-c';
    expect(await applyIdempotentSideEffect(winningWorker.pool, job.id, 'item-1')).toBe(false);

    const resumeCursor = winners[0]!.cursor as { nextItem: number };
    for (let item = resumeCursor.nextItem; item <= 3; item += 1) {
      expect(await applyIdempotentSideEffect(winningWorker.pool, job.id, `item-${item}`)).toBe(
        true,
      );
      await expect(
        winningJobs.checkpoint({
          cursor: { nextItem: item + 1 },
          jobId: job.id,
          leaseMs: 2_000,
          progressDone: item,
          workerId: winningWorkerId,
        }),
      ).resolves.toMatchObject({ progressDone: item });
    }
    await expect(
      winningJobs.complete({
        jobId: job.id,
        resultSummary: { processed: 3 },
        workerId: winningWorkerId,
      }),
    ).resolves.toMatchObject({ status: 'succeeded' });

    const effects = await winningWorker.pool.query<{ count: string; item_key: string }>(
      `
        SELECT item_key, count(*)::text AS count
        FROM platform_job_recovery_effects
        WHERE job_id = $1
        GROUP BY item_key
        ORDER BY item_key
      `,
      [job.id],
    );
    expect(effects.rows).toEqual([
      { count: '1', item_key: 'item-1' },
      { count: '1', item_key: 'item-2' },
      { count: '1', item_key: 'item-3' },
    ]);

    const idempotentReplay = await winningJobs.enqueue({
      idempotencyKey: 'crash-recovery-main',
      type: testJobType,
    });
    expect(idempotentReplay).toMatchObject({ created: false, job: { id: job.id } });

    const retryType = `${testJobType}.retry`;
    const retry = await winningJobs.enqueue({
      idempotencyKey: 'retry-compatibility',
      input: { control: { revision: 18 } },
      maxAttempts: 2,
      type: retryType,
    });
    await winningJobs.claimNext({ types: [retryType], workerId: winningWorkerId });
    await expect(
      winningJobs.fail({
        error: { category: 'transient' },
        jobId: retry.job.id,
        workerId: winningWorkerId,
      }),
    ).resolves.toMatchObject({ attempt: 1, status: 'pending' });
    await expect(
      winningJobs.claimNext({ types: [retryType], workerId: winningWorkerId }),
    ).resolves.toMatchObject({ attempt: 2, input: { control: { revision: 18 } } });
    await winningJobs.complete({ jobId: retry.job.id, workerId: winningWorkerId });

    const cancel = await winningJobs.enqueue({
      idempotencyKey: 'cancel-compatibility',
      input: { control: { revision: 19 } },
      type: `${testJobType}.cancel`,
    });
    await expect(winningJobs.cancel(cancel.job.id)).resolves.toMatchObject({
      attempt: 0,
      input: { control: { revision: 19 } },
      status: 'cancelled',
    });

    const finalJob = await winningJobs.findById(job.id);
    expect(finalJob).toMatchObject({
      attempt: 2,
      cursor: { nextItem: 4 },
      input: { control: { revision: 17 } },
      progressDone: 3,
      status: 'succeeded',
    });
    const finalBacklog = await winningJobs.getBacklogSnapshot();
    expect(finalBacklog.entries.every(({ count }) => count === 0)).toBe(true);
    const activeStatuses = await winningWorker.pool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM platform_jobs
        WHERE status IN ('pending', 'reserved', 'running')
      `,
    );
    expect(activeStatuses.rows[0]?.count).toBe('0');
  });
});
