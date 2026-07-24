/**
 * True multi-connection PostgreSQL evidence for owner-bound file-credential rotation.
 * PGlite serializes writers; this suite proves concurrent CAS + owner isolation on real PG.
 *
 * Gate: TEST_SERVER_DB=1 and DATABASE_TEST_URL.
 *
 * Concurrency proof uses a deterministic two-connection barrier:
 *   1) Writer A acquires FOR UPDATE and parks in afterCredentialLock.
 *   2) Writer B issues the same-row FOR UPDATE; observeDb asserts:
 *        - pg_blocking_pids(B) contains A (B is blocked by A specifically), AND
 *        - B holds an UNGRANTED locktype='transactionid' wait on A's xid
 *          (row locks are not reliably visible as granted tuple locks on A;
 *          waiters block on the holder's transaction id).
 *   3) Barrier releases A (always, even on probe failure); exactly one rotation commits.
 *
 * @vitest-environment node
 */
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { ensureServerTestDatabase } from '../../../tests/ensureServerTestDatabase';
import * as schema from '../../schemas';
import {
  platformGlobalCredentials,
  platformGlobalCredentialSecrets,
  platformGlobalCredentialUploads,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformRevisionConflictError } from './errors';
import {
  fingerprintPayload,
  PlatformGlobalCredentialModel,
  PlatformGlobalCredentialValidationError,
} from './globalCredential';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);

const fakeEnvelope = (seed: string) => ({
  ciphertext: `aihub.secret.v1.test.${seed}`,
  fingerprint: fingerprintPayload(seed),
  keyId: 'test-key-v1',
});

const defer = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const asRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
};

const resolveBackendPid = async (
  observeDb: LobeChatDatabase,
  applicationName: string,
): Promise<number | null> => {
  const result = await observeDb.execute(sql`
    SELECT pid
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND application_name = ${applicationName}
    LIMIT 1
  `);
  const pid = asRows<{ pid?: number }>(result)[0]?.pid;
  return typeof pid === 'number' && Number.isFinite(pid) ? pid : null;
};

/**
 * Poll until writer B is blocked specifically by writer A.
 *
 * Do NOT look for a granted `tuple` lock on A: under PostgreSQL, row locks live
 * on the heap tuple but waiters block on the holder's *transaction id*, so a
 * granted tuple lock is not a reliable observation from another session.
 *
 * Reliable evidence:
 *   1) pg_blocking_pids(B) contains A
 *   2) B has an ungranted locktype='transactionid' whose transactionid is A's xid
 *
 * Combined with the afterCredentialLock barrier (A already holds FOR UPDATE on
 * the credential row), this fails if CAS/serialization no longer contends.
 */
const waitForCredentialRowBlockedByWriterA = async (
  observeDb: LobeChatDatabase,
  params: {
    credentialId: number;
    writerAApp: string;
    writerBApp: string;
  },
  timeoutMs = 10_000,
): Promise<{ blockers: number[]; writerAPid: number; writerBPid: number }> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const writerAPid = await resolveBackendPid(observeDb, params.writerAApp);
    const writerBPid = await resolveBackendPid(observeDb, params.writerBApp);
    if (writerAPid == null || writerBPid == null || writerAPid === writerBPid) {
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }

    // B must be blocked by A (backend-PID specific — not "some" waiter).
    const blockersResult = await observeDb.execute(sql`
      SELECT COALESCE(pg_blocking_pids(${writerBPid}), ARRAY[]::int[]) AS blockers
    `);
    const blockersRaw = asRows<{ blockers?: number[] | string }>(blockersResult)[0]?.blockers;
    const blockers = Array.isArray(blockersRaw)
      ? blockersRaw.map(Number)
      : typeof blockersRaw === 'string'
        ? blockersRaw.replaceAll(/[{}]/g, '').split(',').filter(Boolean).map(Number)
        : [];

    if (!blockers.includes(writerAPid)) {
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }

    // B waits on A's transaction id (ungranted transactionid lock), not a
    // granted tuple lock on A — that observation is unreliable/impossible to
    // assert stably across PG versions and timing.
    const waitResult = await observeDb.execute(sql`
      SELECT
        (
          SELECT a.backend_xid
          FROM pg_stat_activity a
          WHERE a.pid = ${writerAPid}
        ) AS a_xid,
        (
          SELECT count(*)::int
          FROM pg_locks l
          WHERE l.pid = ${writerBPid}
            AND NOT l.granted
            AND l.locktype = 'transactionid'
            AND l.transactionid IS NOT DISTINCT FROM (
              SELECT a.backend_xid
              FROM pg_stat_activity a
              WHERE a.pid = ${writerAPid}
            )
        ) AS b_waits_on_a_xid
    `);
    const row = asRows<{ a_xid?: string | number | null; b_waits_on_a_xid?: number }>(
      waitResult,
    )[0];
    const bWaitsOnAXid = Number(row?.b_waits_on_a_xid ?? 0);
    if (row?.a_xid != null && bWaitsOnAXid >= 1) {
      return { blockers, writerAPid, writerBPid };
    }

    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `Timed out waiting for writer B to be blocked by writer A on credential ${params.credentialId} (pg_blocking_pids + ungranted transactionid wait on A's xid)`,
  );
};

describe.skipIf(!enabled)(
  'PlatformGlobalCredentialModel PostgreSQL multi-connection file rotation',
  () => {
    it('lets exactly one concurrent same-revision rotation win and preserves owner binding', async () => {
      const connectionString = process.env.DATABASE_TEST_URL;
      if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
      await ensureServerTestDatabase(connectionString);

      const runTag = Date.now().toString(36);
      const writerAApp = `gc-rot-a-${runTag}`;
      const writerBApp = `gc-rot-b-${runTag}`;

      const seedPool = new Pool({ connectionString, max: 1 });
      // Dedicated application_name so observeDb can resolve backend PIDs precisely.
      const firstPool = new Pool({
        application_name: writerAApp,
        connectionString,
        max: 1,
      });
      const secondPool = new Pool({
        application_name: writerBApp,
        connectionString,
        max: 1,
      });
      const observePool = new Pool({ connectionString, max: 1 });
      const seedDb = drizzle(seedPool, { schema }) as unknown as LobeChatDatabase;
      const firstDb = drizzle(firstPool, { schema }) as unknown as LobeChatDatabase;
      const secondDb = drizzle(secondPool, { schema }) as unknown as LobeChatDatabase;
      const observeDb = drizzle(observePool, { schema }) as unknown as LobeChatDatabase;

      const actor = `admin-mc-${runTag}`;
      const other = `admin-other-${runTag}`;
      const key = `file-mc-${runTag}`;
      let credentialId = 0;
      const releaseFirst = defer<void>();

      try {
        const seed = new PlatformGlobalCredentialModel(seedDb);
        const created = await seed.create({
          createdBy: actor,
          envelope: fakeEnvelope('mc-v1'),
          key,
          meta: { fileName: 'v1.bin', fileSize: 8, maskedPreview: 'v1.bin' },
          name: 'MC rotate',
          type: 'file',
        });
        credentialId = created.id;

        const hashA = 'a'.repeat(64);
        const hashB = 'b'.repeat(64);
        const hashOther = 'c'.repeat(64);
        await seed.stageUpload({
          createdBy: actor,
          envelope: fakeEnvelope('mc-a'),
          expiresAt: new Date(Date.now() + 120_000),
          fileHashId: hashA,
          fileName: 'a.bin',
          fileSize: 4,
          fileType: 'application/octet-stream',
        });
        await seed.stageUpload({
          createdBy: actor,
          envelope: fakeEnvelope('mc-b'),
          expiresAt: new Date(Date.now() + 120_000),
          fileHashId: hashB,
          fileName: 'b.bin',
          fileSize: 4,
          fileType: 'application/octet-stream',
        });
        // Cross-owner staged row with the same content hash shape must never be consumed.
        await seed.stageUpload({
          createdBy: other,
          envelope: fakeEnvelope('mc-stolen'),
          expiresAt: new Date(Date.now() + 120_000),
          fileHashId: hashOther,
          fileName: 'stolen.bin',
          fileSize: 6,
          fileType: 'application/octet-stream',
        });

        const first = new PlatformGlobalCredentialModel(firstDb);
        const second = new PlatformGlobalCredentialModel(secondDb);

        const firstLocked = defer<void>();
        // Writer A holds the credential row lock at afterCredentialLock until released.
        const firstPromise = first.updateFromStagedUpload({
          createdBy: actor,
          expectedRevision: created.revision,
          fileHashId: hashA,
          id: created.id,
          testHooks: {
            afterCredentialLock: async () => {
              firstLocked.resolve();
              await releaseFirst.promise;
            },
          },
        });

        await firstLocked.promise;

        // Writer B starts while A still holds FOR UPDATE — must block, not run serially after.
        const secondPromise = second.updateFromStagedUpload({
          createdBy: actor,
          expectedRevision: created.revision,
          fileHashId: hashB,
          id: created.id,
        });

        try {
          const contention = await waitForCredentialRowBlockedByWriterA(observeDb, {
            credentialId: created.id,
            writerAApp,
            writerBApp,
          });
          expect(contention.writerAPid).toBeGreaterThan(0);
          expect(contention.writerBPid).toBeGreaterThan(0);
          expect(contention.writerAPid).not.toBe(contention.writerBPid);
          expect(contention.blockers).toContain(contention.writerAPid);
        } finally {
          // Unconditional barrier release so A cannot hang if the probe fails.
          releaseFirst.resolve();
        }

        const results = await Promise.allSettled([firstPromise, secondPromise]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toMatchObject({ reason: expect.any(PlatformRevisionConflictError) });

        const head = await seed.getById(created.id);
        expect(head?.revision).toBe(created.revision + 1);
        expect(['a.bin', 'b.bin']).toContain(head?.fileName);
        expect(head?.key).toBe(key);
        expect(head?.id).toBe(created.id);

        const winnerHash = head?.fileName === 'a.bin' ? hashA : hashB;
        const loserHash = head?.fileName === 'a.bin' ? hashB : hashA;
        await expect(seed.getStagedUpload(winnerHash, actor)).resolves.toBeNull();
        await expect(seed.getStagedUpload(loserHash, actor)).resolves.not.toBeNull();
        // Other admin's staging row is untouched (no cross-owner leakage / consumption).
        await expect(seed.getStagedUpload(hashOther, other)).resolves.toMatchObject({
          fileName: 'stolen.bin',
        });
        await expect(
          seed.updateFromStagedUpload({
            createdBy: actor,
            expectedRevision: head!.revision,
            fileHashId: hashOther,
            id: created.id,
          }),
        ).rejects.toBeInstanceOf(PlatformGlobalCredentialValidationError);

        const active = await seed.getActiveSecretEnvelope(created.id);
        expect(active?.ciphertext).toMatch(/^aihub\.secret\.v1\.test\.mc-[ab]$/);
        expect(await seed.countSecrets(created.id)).toBe(2);
      } finally {
        releaseFirst.resolve();
        if (credentialId > 0) {
          await seedDb
            .delete(platformGlobalCredentialSecrets)
            .where(eq(platformGlobalCredentialSecrets.credentialId, credentialId));
          await seedDb
            .delete(platformGlobalCredentials)
            .where(eq(platformGlobalCredentials.id, credentialId));
        }
        await seedDb
          .delete(platformGlobalCredentialUploads)
          .where(eq(platformGlobalCredentialUploads.createdBy, actor));
        await seedDb
          .delete(platformGlobalCredentialUploads)
          .where(eq(platformGlobalCredentialUploads.createdBy, other));
        await Promise.all([seedPool.end(), firstPool.end(), secondPool.end(), observePool.end()]);
      }
    }, 45_000);
  },
);
