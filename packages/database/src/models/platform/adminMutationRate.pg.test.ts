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

  it('never stores raw actor identifiers', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    await model.consume({
      limit: 3,
      scopeDigest: 'f'.repeat(64),
      windowMs: 60_000,
    });
    const rows = await db.select().from(platformAdminMutationRateWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopeDigest).toBe('f'.repeat(64));
    expect(JSON.stringify(rows)).not.toMatch(/user-|admin\./);
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
 * Real PostgreSQL multi-connection race + plan checks.
 * Self-contained DDL (no full migrate / pg_search) so a plain Postgres works.
 *
 * Run:
 *   DATABASE_TEST_URL=postgresql://... bunx vitest run \
 *     src/models/platform/adminMutationRate.pg.test.ts
 */
describe.skipIf(!isRealPostgres)(
  'PlatformAdminMutationRateModel cleanup concurrency (real PostgreSQL)',
  () => {
    const ensureRateTable = async (pool: Pool) => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS platform_admin_mutation_rate_windows (
          scope_digest text PRIMARY KEY NOT NULL,
          window_start timestamptz NOT NULL,
          count integer DEFAULT 0 NOT NULL,
          updated_at timestamptz DEFAULT now() NOT NULL
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS platform_admin_mutation_rate_windows_window_start_idx
          ON platform_admin_mutation_rate_windows USING btree (window_start)
      `);
    };

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
          windowStart: staleStart,
        });

        // Connection A: lock the expired row as a concurrent consume would, then reset it.
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

          // Connection B: cleanup while A holds the row lock — must SKIP LOCKED or wait + recheck.
          const cleanupModel = new PlatformAdminMutationRateModel(cleanupDb);
          const cleanupPromise = cleanupModel.cleanupExpired({ limit: 10, maxAgeMs });

          // Give cleanup a moment to attempt candidate selection under the held lock.
          await new Promise((resolve) => setTimeout(resolve, 50));

          // A resets the row to a fresh active window (mirrors consume rollover).
          await holderClient.query(
            `UPDATE platform_admin_mutation_rate_windows
             SET count = 1, window_start = now(), updated_at = now()
             WHERE scope_digest = $1`,
            [digest],
          );
          await holderClient.query('COMMIT');

          const deleted = await cleanupPromise;
          // Either skipped while locked (deleted=0) or revalidated after unlock (still 0 for this row).
          expect(deleted).toBe(0);

          const rows = await cleanupDb.select().from(platformAdminMutationRateWindows);
          expect(rows).toHaveLength(1);
          expect(rows[0]!.scopeDigest).toBe(digest);
          expect(rows[0]!.count).toBe(1);

          // Active quota not expanded/reset by cleanup.
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

    it('cleanup uses a sargable window_start range (index-friendly plan)', async () => {
      const pool = new Pool({ connectionString: realPostgresUrl, max: 1 });
      const pgDb = drizzle(pool, { schema }) as unknown as LobeChatDatabase;
      const staleStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      try {
        await ensureRateTable(pool);
        await pool.query('DELETE FROM platform_admin_mutation_rate_windows');
        // Enough rows that a non-sargable expression would prefer seq scan.
        const values = Array.from({ length: 2000 }, (_, i) => ({
          count: 1,
          scopeDigest: `plan${i.toString(16).padStart(60, '0')}`,
          updatedAt: staleStart,
          windowStart: new Date(staleStart.getTime() + i * 1000),
        }));
        for (let i = 0; i < values.length; i += 200) {
          await pgDb.insert(platformAdminMutationRateWindows).values(values.slice(i, i + 200));
        }
        await pool.query('ANALYZE platform_admin_mutation_rate_windows');

        const planResult = await pool.query(`
          EXPLAIN (FORMAT TEXT)
          WITH candidates AS (
            SELECT scope_digest
            FROM platform_admin_mutation_rate_windows
            WHERE window_start < (now() - (86400000::bigint * interval '1 millisecond'))
            ORDER BY window_start ASC
            LIMIT 10
            FOR UPDATE SKIP LOCKED
          )
          DELETE FROM platform_admin_mutation_rate_windows AS t
          USING candidates AS c
          WHERE t.scope_digest = c.scope_digest
            AND t.window_start < (now() - (86400000::bigint * interval '1 millisecond'))
          RETURNING t.scope_digest
        `);
        const planText = planResult.rows
          .map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN'])
          .join('\n');
        // Index-friendly candidate selection: Index/Bitmap path preferred over pure Seq Scan.
        expect(planText).toMatch(/Index|Bitmap/i);
        expect(planText).toMatch(
          /platform_admin_mutation_rate_windows_window_start_idx|window_start/i,
        );

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
