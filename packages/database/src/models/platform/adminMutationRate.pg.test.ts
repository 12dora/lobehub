// @vitest-environment node
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import * as schema from '../../schemas';
import { platformAdminMutationRateWindows } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAdminMutationRateModel } from './adminMutationRate';

const db: LobeChatDatabase = await getTestDB();
/** Real multi-connection Postgres only — does not require full migrate/pg_search. */
const realPostgresUrl = process.env.DATABASE_TEST_URL?.trim() || '';
const isRealPostgres = realPostgresUrl.length > 0;

const cleanup = async () => {
  await db.delete(platformAdminMutationRateWindows);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformAdminMutationRateModel (PostgreSQL)', () => {
  it('allows through the boundary and denies above it with independent scopes', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    const scopeA = { limit: 2, scopeDigest: 'a'.repeat(64), windowMs: 60_000 };
    const scopeB = { limit: 2, scopeDigest: 'b'.repeat(64), windowMs: 60_000 };

    await expect(model.consume(scopeA)).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(model.consume(scopeA)).resolves.toMatchObject({ allowed: true, count: 2 });
    await expect(model.consume(scopeA)).resolves.toMatchObject({ allowed: false, count: 3 });
    await expect(model.consume(scopeB)).resolves.toMatchObject({ allowed: true, count: 1 });
  });

  it('shares state across independent model instances', async () => {
    const first = new PlatformAdminMutationRateModel(db);
    const second = new PlatformAdminMutationRateModel(db);
    const scope = { limit: 2, scopeDigest: 'c'.repeat(64), windowMs: 60_000 };

    await expect(first.consume(scope)).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(second.consume(scope)).resolves.toMatchObject({ allowed: true, count: 2 });
    await expect(first.consume(scope)).resolves.toMatchObject({ allowed: false, count: 3 });
  });

  it('handles concurrent boundary races without under-counting', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    const scope = { limit: 5, scopeDigest: 'd'.repeat(64), windowMs: 60_000 };
    const results = await Promise.all(Array.from({ length: 20 }, () => model.consume(scope)));
    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;
    expect(allowed).toBe(5);
    expect(denied).toBe(15);
    expect(Math.max(...results.map((r) => r.count))).toBe(20);
  });

  it('rolls the window using the database clock after window expiry', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    const scope = { limit: 1, scopeDigest: 'e'.repeat(64), windowMs: 50 };

    await expect(model.consume(scope)).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(model.consume(scope)).resolves.toMatchObject({ allowed: false, count: 2 });

    await new Promise((resolve) => setTimeout(resolve, 80));

    await expect(model.consume(scope)).resolves.toMatchObject({ allowed: true, count: 1 });
  });

  it('never stores raw actor identifiers and persists window_ms', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    await model.consume({
      limit: 3,
      scopeDigest: 'f'.repeat(64),
      windowMs: 60_000,
    });
    const rows = await db.select().from(platformAdminMutationRateWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopeDigest).toBe('f'.repeat(64));
    expect(rows[0]!.windowMs).toBe(60_000);
    expect(JSON.stringify(rows)).not.toMatch(/user-|admin\./);
  });

  it('ignores short-window replica config while a long persisted window is active', async () => {
    const longReplica = new PlatformAdminMutationRateModel(db);
    const shortReplica = new PlatformAdminMutationRateModel(db);
    const digest = '7'.repeat(64);

    await expect(
      longReplica.consume({ limit: 5, scopeDigest: digest, windowMs: 60_000 }),
    ).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(
      longReplica.consume({ limit: 5, scopeDigest: digest, windowMs: 60_000 }),
    ).resolves.toMatchObject({ allowed: true, count: 2 });

    // Short local config must not reset mid-window.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(
      shortReplica.consume({ limit: 5, scopeDigest: digest, windowMs: 50 }),
    ).resolves.toMatchObject({ allowed: true, count: 3 });

    const rows = await db.select().from(platformAdminMutationRateWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(3);
    expect(rows[0]!.windowMs).toBe(60_000);
  });

  it('adopts a new local window_ms only after the persisted window expires', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    const digest = '8'.repeat(64);

    await expect(
      model.consume({ limit: 2, scopeDigest: digest, windowMs: 50 }),
    ).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(
      model.consume({ limit: 2, scopeDigest: digest, windowMs: 50 }),
    ).resolves.toMatchObject({ allowed: true, count: 2 });

    // Mid-window longer config must not change duration or reset count.
    await expect(
      model.consume({ limit: 2, scopeDigest: digest, windowMs: 60_000 }),
    ).resolves.toMatchObject({ allowed: false, count: 3 });
    expect((await db.select().from(platformAdminMutationRateWindows))[0]!.windowMs).toBe(50);

    await new Promise((resolve) => setTimeout(resolve, 80));

    // After expiry, new window adopts the caller's window_ms.
    await expect(
      model.consume({ limit: 2, scopeDigest: digest, windowMs: 60_000 }),
    ).resolves.toMatchObject({ allowed: true, count: 1 });
    const rows = await db.select().from(platformAdminMutationRateWindows);
    expect(rows[0]!.count).toBe(1);
    expect(rows[0]!.windowMs).toBe(60_000);
  });

  it('cleanupExpired deletes only stale windows in bounded batches without expanding live quota', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    const live = { limit: 2, scopeDigest: '1'.repeat(64), windowMs: 60_000 };

    // Live scope via normal consume (fresh window_start).
    await model.consume(live);

    // Stale rows: window_start far in the past so cleanup can select them by age.
    const staleStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 30; i++) {
      const digest = `${i.toString(16).padStart(2, '0')}${'a'.repeat(62)}`;
      await db.insert(platformAdminMutationRateWindows).values({
        count: 1,
        scopeDigest: digest,
        updatedAt: staleStart,
        windowMs: 60_000,
        windowStart: staleStart,
      });
    }

    const deleted = await model.cleanupExpired({
      limit: 10,
      maxAgeMs: 24 * 60 * 60 * 1000,
    });
    expect(deleted).toBe(10);

    // Live scope still exact: second consume allowed, third limited.
    await expect(model.consume(live)).resolves.toMatchObject({ allowed: true, count: 2 });
    await expect(model.consume(live)).resolves.toMatchObject({ allowed: false, count: 3 });

    // Concurrent cleanup must not expand quota on a saturated scope.
    await Promise.all([
      model.cleanupExpired({ limit: 50, maxAgeMs: 24 * 60 * 60 * 1000 }),
      model.cleanupExpired({ limit: 50, maxAgeMs: 24 * 60 * 60 * 1000 }),
    ]);
    await expect(model.consume(live)).resolves.toMatchObject({ allowed: false });
  });

  it('cleanup revalidates expiry so a row reset by consume is not deleted', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    const digest = '2'.repeat(64);
    const staleStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    await db.insert(platformAdminMutationRateWindows).values({
      count: 9,
      scopeDigest: digest,
      updatedAt: staleStart,
      windowMs: 60_000,
      windowStart: staleStart,
    });

    // Consume rolls the expired window into a fresh active quota (count=1).
    await expect(
      model.consume({ limit: 2, scopeDigest: digest, windowMs: 60_000 }),
    ).resolves.toMatchObject({ allowed: true, count: 1 });

    // Cleanup must not delete the freshly reset active row.
    const deleted = await model.cleanupExpired({
      limit: 100,
      maxAgeMs: 24 * 60 * 60 * 1000,
    });
    expect(deleted).toBe(0);

    const rows = await db.select().from(platformAdminMutationRateWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopeDigest).toBe(digest);
    expect(rows[0]!.count).toBe(1);

    // Live quota still exact after cleanup.
    await expect(
      model.consume({ limit: 2, scopeDigest: digest, windowMs: 60_000 }),
    ).resolves.toMatchObject({ allowed: true, count: 2 });
    await expect(
      model.consume({ limit: 2, scopeDigest: digest, windowMs: 60_000 }),
    ).resolves.toMatchObject({ allowed: false, count: 3 });
  });
});

/**
 * Real PostgreSQL multi-connection race, config-drift, and plan checks.
 * Self-contained DDL (no full migrate / pg_search) so a plain Postgres works.
 *
 * Run:
 *   DATABASE_TEST_URL=postgresql://... bunx vitest run \
 *     src/models/platform/adminMutationRate.pg.test.ts
 */
describe.skipIf(!isRealPostgres)(
  'PlatformAdminMutationRateModel real PostgreSQL concurrency & plans',
  () => {
    const ensureRateTable = async (pool: Pool) => {
      // Drop/recreate so local QA DBs always match the branch schema (window_ms).
      await pool.query(`DROP TABLE IF EXISTS platform_admin_mutation_rate_windows`);
      await pool.query(`
        CREATE TABLE platform_admin_mutation_rate_windows (
          scope_digest text PRIMARY KEY NOT NULL,
          window_start timestamptz NOT NULL,
          window_ms integer NOT NULL,
          count integer DEFAULT 0 NOT NULL,
          updated_at timestamptz DEFAULT now() NOT NULL
        )
      `);
      await pool.query(`
        CREATE INDEX platform_admin_mutation_rate_windows_window_start_idx
          ON platform_admin_mutation_rate_windows USING btree (window_start)
      `);
    };

    const planLines = (planText: string) =>
      planText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    it('does not delete a row reset under FOR UPDATE contention', async () => {
      const holderPool = new Pool({ connectionString: realPostgresUrl, max: 1 });
      const cleanupPool = new Pool({ connectionString: realPostgresUrl, max: 1 });
      const holderDb = drizzle(holderPool, { schema }) as unknown as LobeChatDatabase;
      const cleanupDb = drizzle(cleanupPool, { schema }) as unknown as LobeChatDatabase;
      const digest = '3'.repeat(64);
      const staleStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const maxAgeMs = 24 * 60 * 60 * 1000;

      const wipe = async () => {
        await holderPool.query('DELETE FROM platform_admin_mutation_rate_windows');
      };

      try {
        await ensureRateTable(holderPool);
        await wipe();
        await holderDb.insert(platformAdminMutationRateWindows).values({
          count: 5,
          scopeDigest: digest,
          updatedAt: staleStart,
          windowMs: 60_000,
          windowStart: staleStart,
        });

        const holderClient = await holderPool.connect();
        try {
          await holderClient.query('BEGIN');
          const locked = await holderClient.query(
            `SELECT scope_digest, window_start, count
             FROM platform_admin_mutation_rate_windows
             WHERE scope_digest = $1
             FOR UPDATE`,
            [digest],
          );
          expect(locked.rowCount).toBe(1);

          const cleanupModel = new PlatformAdminMutationRateModel(cleanupDb);
          const cleanupPromise = cleanupModel.cleanupExpired({ limit: 10, maxAgeMs });

          await new Promise((resolve) => setTimeout(resolve, 50));

          await holderClient.query(
            `UPDATE platform_admin_mutation_rate_windows
             SET count = 1, window_start = now(), window_ms = 60000, updated_at = now()
             WHERE scope_digest = $1`,
            [digest],
          );
          await holderClient.query('COMMIT');

          const deleted = await cleanupPromise;
          expect(deleted).toBe(0);

          const rows = await cleanupDb.select().from(platformAdminMutationRateWindows);
          expect(rows).toHaveLength(1);
          expect(rows[0]!.scopeDigest).toBe(digest);
          expect(rows[0]!.count).toBe(1);

          const model = new PlatformAdminMutationRateModel(cleanupDb);
          await expect(
            model.consume({ limit: 2, scopeDigest: digest, windowMs: 60_000 }),
          ).resolves.toMatchObject({ allowed: true, count: 2 });
          await expect(
            model.consume({ limit: 2, scopeDigest: digest, windowMs: 60_000 }),
          ).resolves.toMatchObject({ allowed: false, count: 3 });
        } finally {
          try {
            await holderClient.query('ROLLBACK');
          } catch {
            // already committed
          }
          holderClient.release();
        }
      } finally {
        await wipe().catch(() => undefined);
        await Promise.all([holderPool.end(), cleanupPool.end()]);
      }
    }, 20_000);

    it('long→short replica drift preserves active window and count', async () => {
      const longPool = new Pool({ connectionString: realPostgresUrl, max: 1 });
      const shortPool = new Pool({ connectionString: realPostgresUrl, max: 1 });
      const longDb = drizzle(longPool, { schema }) as unknown as LobeChatDatabase;
      const shortDb = drizzle(shortPool, { schema }) as unknown as LobeChatDatabase;
      const digest = '4'.repeat(64);

      try {
        await ensureRateTable(longPool);
        await longPool.query('DELETE FROM platform_admin_mutation_rate_windows');

        const longModel = new PlatformAdminMutationRateModel(longDb);
        const shortModel = new PlatformAdminMutationRateModel(shortDb);

        await expect(
          longModel.consume({ limit: 5, scopeDigest: digest, windowMs: 60_000 }),
        ).resolves.toMatchObject({ allowed: true, count: 1 });
        await expect(
          longModel.consume({ limit: 5, scopeDigest: digest, windowMs: 60_000 }),
        ).resolves.toMatchObject({ allowed: true, count: 2 });

        await new Promise((resolve) => setTimeout(resolve, 1100));

        // Short-config replica must continue the same 60s window (count=3), not reset.
        await expect(
          shortModel.consume({ limit: 5, scopeDigest: digest, windowMs: 1000 }),
        ).resolves.toMatchObject({ allowed: true, count: 3 });

        const rows = await longDb.select().from(platformAdminMutationRateWindows);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.count).toBe(3);
        expect(rows[0]!.windowMs).toBe(60_000);
      } finally {
        await longPool
          .query('DELETE FROM platform_admin_mutation_rate_windows')
          .catch(() => undefined);
        await Promise.all([longPool.end(), shortPool.end()]);
      }
    }, 20_000);

    it('short→long replica drift preserves active short window until boundary', async () => {
      const shortPool = new Pool({ connectionString: realPostgresUrl, max: 1 });
      const longPool = new Pool({ connectionString: realPostgresUrl, max: 1 });
      const shortDb = drizzle(shortPool, { schema }) as unknown as LobeChatDatabase;
      const longDb = drizzle(longPool, { schema }) as unknown as LobeChatDatabase;
      const digest = '5'.repeat(64);

      try {
        await ensureRateTable(shortPool);
        await shortPool.query('DELETE FROM platform_admin_mutation_rate_windows');

        const shortModel = new PlatformAdminMutationRateModel(shortDb);
        const longModel = new PlatformAdminMutationRateModel(longDb);

        await expect(
          shortModel.consume({ limit: 2, scopeDigest: digest, windowMs: 1000 }),
        ).resolves.toMatchObject({ allowed: true, count: 1 });
        await expect(
          shortModel.consume({ limit: 2, scopeDigest: digest, windowMs: 1000 }),
        ).resolves.toMatchObject({ allowed: true, count: 2 });

        // Mid-window: long config must not reset or stretch the active short window.
        await expect(
          longModel.consume({ limit: 2, scopeDigest: digest, windowMs: 60_000 }),
        ).resolves.toMatchObject({ allowed: false, count: 3 });
        expect((await shortDb.select().from(platformAdminMutationRateWindows))[0]!.windowMs).toBe(
          1000,
        );

        await new Promise((resolve) => setTimeout(resolve, 1100));

        // New window boundary adopts the long replica's config.
        await expect(
          longModel.consume({ limit: 2, scopeDigest: digest, windowMs: 60_000 }),
        ).resolves.toMatchObject({ allowed: true, count: 1 });
        const rows = await shortDb.select().from(platformAdminMutationRateWindows);
        expect(rows[0]!.count).toBe(1);
        expect(rows[0]!.windowMs).toBe(60_000);
      } finally {
        await shortPool
          .query('DELETE FROM platform_admin_mutation_rate_windows')
          .catch(() => undefined);
        await Promise.all([shortPool.end(), longPool.end()]);
      }
    }, 20_000);

    it('cleanup plan uses window_start index for candidates and tid path for delete', async () => {
      const pool = new Pool({ connectionString: realPostgresUrl, max: 1 });
      const pgDb = drizzle(pool, { schema }) as unknown as LobeChatDatabase;
      const staleStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      try {
        await ensureRateTable(pool);
        await pool.query('DELETE FROM platform_admin_mutation_rate_windows');
        const values = Array.from({ length: 2000 }, (_, i) => ({
          count: 1,
          scopeDigest: `plan${i.toString(16).padStart(60, '0')}`,
          updatedAt: staleStart,
          windowMs: 60_000,
          windowStart: new Date(staleStart.getTime() + i * 1000),
        }));
        for (let i = 0; i < values.length; i += 200) {
          await pgDb.insert(platformAdminMutationRateWindows).values(values.slice(i, i + 200));
        }
        await pool.query('ANALYZE platform_admin_mutation_rate_windows');

        // Match production cleanup SQL shape (ctid candidates + recheck).
        const planResult = await pool.query(`
          EXPLAIN (FORMAT TEXT)
          WITH candidates AS (
            SELECT ctid AS row_ctid
            FROM platform_admin_mutation_rate_windows
            WHERE window_start < (now() - (86400000::bigint * interval '1 millisecond'))
            ORDER BY window_start ASC
            LIMIT 10
            FOR UPDATE SKIP LOCKED
          )
          DELETE FROM platform_admin_mutation_rate_windows AS t
          WHERE t.ctid IN (SELECT row_ctid FROM candidates)
            AND t.window_start < (now() - (86400000::bigint * interval '1 millisecond'))
          RETURNING t.scope_digest
        `);
        const planText = planResult.rows
          .map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN'])
          .join('\n');
        const lines = planLines(planText);

        // Candidate discovery must hit the window_start index (not merely any index elsewhere).
        const candidateIndexLine = lines.find(
          (line) =>
            /platform_admin_mutation_rate_windows_window_start_idx/i.test(line) &&
            /Index|Bitmap/i.test(line),
        );
        if (!candidateIndexLine) {
          throw new Error(`candidate discovery missing window_start index path:\n${planText}`);
        }

        // Hash Join + full Seq Scan of the target table is the unbounded-delete failure mode.
        const badHashJoinSeq =
          /Hash Join/i.test(planText) &&
          /Seq Scan on platform_admin_mutation_rate_windows/i.test(planText);
        if (badHashJoinSeq) {
          throw new Error(`unexpected hash join + seq scan delete plan:\n${planText}`);
        }

        // Target delete must use physical identity (tid/ctid), not an unbounded heap scan alone.
        const hasTidPath = /Tid Scan|tid |ctid/i.test(planText);
        if (!hasTidPath) {
          throw new Error(`delete path missing tid/ctid targeting:\n${planText}`);
        }
        expect(candidateIndexLine).toMatch(/window_start_idx/i);

        const model = new PlatformAdminMutationRateModel(pgDb);
        const deleted = await model.cleanupExpired({
          limit: 10,
          maxAgeMs: 24 * 60 * 60 * 1000,
        });
        expect(deleted).toBe(10);
      } finally {
        await pool.query('DELETE FROM platform_admin_mutation_rate_windows').catch(() => undefined);
        await pool.end();
      }
    }, 20_000);
  },
);
