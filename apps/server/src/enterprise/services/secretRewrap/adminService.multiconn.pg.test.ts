/**
 * TRUE multi-connection PostgreSQL evidence for secret-rotation restart CAS.
 * PGlite single-connection suites cannot prove independent-session race winners.
 * Runs only with TEST_SERVER_DB=1 plus DATABASE_TEST_URL.
 *
 * @vitest-environment node
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import * as schema from '@/database/schemas';
import { platformJobs } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import {
  type KekMaterial,
  type KeyProvider,
  PlatformSecretService,
} from '@/server/enterprise/security/secret';

import { PlatformSecretRotationAdminService } from './adminService';
import { PLATFORM_SECRET_REWRAP_JOB_TYPE } from './contracts';
import { PlatformSecretRewrapCoordinator } from './coordinator';
import { PlatformSecretRewrapConflictError } from './errors';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;
const targetKeyId = 'vault:pg-restart-target';
const oldKeyId = 'vault:pg-restart-old';

class PgVaultProvider implements KeyProvider {
  activeKeyId = targetKeyId;
  readonly providerId = 'vault';
  readonly #keys = new Map([
    [oldKeyId, randomBytes(32)],
    [targetKeyId, randomBytes(32)],
  ]);

  getKek = async (keyId?: string): Promise<KekMaterial> => {
    const resolvedKeyId = keyId ?? this.activeKeyId;
    const key = this.#keys.get(resolvedKeyId);
    if (!key) throw new Error('test key is missing');
    return { key: new Uint8Array(key), keyId: resolvedKeyId };
  };
}

run('Platform secret rotation restart — true multi-connection PostgreSQL', () => {
  const connectionString = process.env.DATABASE_TEST_URL!;
  const pools: Pool[] = [];
  const provider = new PgVaultProvider();
  const secrets = new PlatformSecretService({ keyProvider: provider });
  const coordinator = new PlatformSecretRewrapCoordinator(secrets);
  let db: LobeChatDatabase;
  const actorUserId = 'pg-restart-actor';

  const sessionDb = (): LobeChatDatabase => {
    const pool = new Pool({ connectionString, max: 1 });
    pools.push(pool);
    return drizzle(pool, { schema }) as unknown as LobeChatDatabase;
  };

  const serviceFor = (session: LobeChatDatabase) =>
    new PlatformSecretRotationAdminService(session, () => coordinator);

  const cleanup = () =>
    db.execute(sql`
      TRUNCATE TABLE ${platformJobs}
      RESTART IDENTITY CASCADE
    `);

  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(async () => {
    await cleanup();
    provider.activeKeyId = targetKeyId;
  });
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    await cleanup();
  });
  afterAll(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it('lets exactly one independent session win a concurrent cancelled-job restart (CAS)', async () => {
    const seed = serviceFor(db);
    const started = await seed.start(actorUserId, {
      reason: 'seed job for multi-connection restart race',
      requestId: randomUUID(),
      targetKeyId,
    });
    // Partial progress that only one winner should clear coherently.
    await db
      .update(platformJobs)
      .set({ progressDone: 4, progressTotal: 9 })
      .where(eq(platformJobs.id, started.jobId));
    const cancelled = await seed.cancel(actorUserId, {
      expectedRevision: started.revision,
      expectedStatus: 'pending',
      jobId: started.jobId,
      reason: 'cancel for multi-connection restart race',
      requestId: randomUUID(),
    });

    const intent = {
      expectedRevision: cancelled.revision,
      expectedStatus: 'cancelled' as const,
      jobId: cancelled.jobId,
      reason: 'multi-connection concurrent restart',
    };
    const results = await Promise.allSettled([
      serviceFor(sessionDb()).restart(actorUserId, { ...intent, requestId: randomUUID() }),
      serviceFor(sessionDb()).restart(actorUserId, { ...intent, requestId: randomUUID() }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({
      status: 'fulfilled',
      value: {
        jobId: cancelled.jobId,
        revision: cancelled.revision + 1,
        status: 'pending',
      },
    });
    expect(rejected[0]).toMatchObject({
      status: 'rejected',
      reason: expect.any(PlatformSecretRewrapConflictError),
    });

    const [row] = await db.select().from(platformJobs).where(eq(platformJobs.id, cancelled.jobId));
    expect(row).toMatchObject({
      progressDone: 0,
      progressTotal: null,
      status: 'pending',
      type: PLATFORM_SECRET_REWRAP_JOB_TYPE,
    });
  });

  it('lets exactly one independent session win a concurrent dead-job restart (CAS)', async () => {
    const seed = serviceFor(db);
    const started = await seed.start(actorUserId, {
      reason: 'seed dead job for multi-connection restart race',
      requestId: randomUUID(),
      targetKeyId,
    });
    await db
      .update(platformJobs)
      .set({
        attempt: 3,
        finishedAt: sql`clock_timestamp()`,
        lastError: { category: 'invalid_job_contract' },
        progressDone: 5,
        progressTotal: 11,
        status: 'dead',
      })
      .where(eq(platformJobs.id, started.jobId));

    const intent = {
      expectedRevision: started.revision,
      expectedStatus: 'dead' as const,
      jobId: started.jobId,
      reason: 'multi-connection concurrent dead restart',
    };
    const results = await Promise.allSettled([
      serviceFor(sessionDb()).restart(actorUserId, { ...intent, requestId: randomUUID() }),
      serviceFor(sessionDb()).restart(actorUserId, { ...intent, requestId: randomUUID() }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: expect.any(PlatformSecretRewrapConflictError),
    });

    const [row] = await db.select().from(platformJobs).where(eq(platformJobs.id, started.jobId));
    expect(row).toMatchObject({
      attempt: 0,
      lastError: null,
      progressDone: 0,
      progressTotal: null,
      status: 'pending',
    });
  });

  it('lets concurrent same-requestId restarts both succeed (replay-idempotent)', async () => {
    const seed = serviceFor(db);
    const started = await seed.start(actorUserId, {
      reason: 'seed for same-requestId multi-connection replay',
      requestId: randomUUID(),
      targetKeyId,
    });
    const cancelled = await seed.cancel(actorUserId, {
      expectedRevision: started.revision,
      expectedStatus: 'pending',
      jobId: started.jobId,
      reason: 'cancel for same-requestId replay race',
      requestId: randomUUID(),
    });

    const sharedRequestId = randomUUID();
    const intent = {
      expectedRevision: cancelled.revision,
      expectedStatus: 'cancelled' as const,
      jobId: cancelled.jobId,
      reason: 'multi-connection same requestId restart',
      requestId: sharedRequestId,
    };
    const results = await Promise.allSettled([
      serviceFor(sessionDb()).restart(actorUserId, intent),
      serviceFor(sessionDb()).restart(actorUserId, intent),
    ]);

    // Both must settle as fulfilled: winner performs the transition, loser replays.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    const values = results
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<
          Awaited<ReturnType<PlatformSecretRotationAdminService['restart']>>
        > => r.status === 'fulfilled',
      )
      .map((r) => r.value);
    expect(values[0]).toEqual(values[1]);
    expect(values[0]).toMatchObject({
      jobId: cancelled.jobId,
      revision: cancelled.revision + 1,
      status: 'pending',
    });

    const [row] = await db.select().from(platformJobs).where(eq(platformJobs.id, cancelled.jobId));
    expect(row).toMatchObject({
      progressDone: 0,
      progressTotal: null,
      status: 'pending',
    });
    expect(row.input).toMatchObject({
      control: { revision: cancelled.revision + 1 },
      requestId: sharedRequestId,
    });
  });
});
