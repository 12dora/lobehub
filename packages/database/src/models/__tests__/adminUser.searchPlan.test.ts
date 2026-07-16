// @vitest-environment node
/**
 * EXPLAIN plan evidence that admin prefix search uses lower(field) text_pattern_ops indexes.
 * Fails on pure Seq Scan at representative cardinality.
 *
 * Run: TEST_SERVER_DB=1 DATABASE_TEST_URL=... bunx vitest run src/models/__tests__/adminUser.searchPlan.test.ts
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { escapeAdminUserLikePattern } from '../adminUser';

const isServerDB = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);

describe.skipIf(!isServerDB)('M04 prefix search EXPLAIN (TEST_SERVER_DB=1)', () => {
  let db: LobeChatDatabase;
  const prefixUser = 'explain_prefix_user_unique';

  beforeEach(async () => {
    db = await getTestDB();
    await db.delete(users).where(sql`${users.id} like 'explain-%'`);
    // Representative cardinality so planner prefers expression index for selective prefix.
    const rows = Array.from({ length: 800 }, (_, i) => ({
      email: `explain-bulk-${i}@example.com`,
      id: `explain-bulk-${i}`,
      normalizedEmail: `explain-bulk-${i}@example.com`,
      username: `explain_bulk_${i}`,
    }));
    rows.push({
      email: `${prefixUser}@example.com`,
      id: 'explain-hit',
      normalizedEmail: `${prefixUser}@example.com`,
      username: prefixUser,
    });
    // Insert in chunks
    for (let i = 0; i < rows.length; i += 100) {
      await db.insert(users).values(rows.slice(i, i + 100));
    }
    await db.execute(sql`ANALYZE users`);
  });

  afterEach(async () => {
    if (!db) return;
    await db.delete(users).where(sql`${users.id} like 'explain-%'`);
  });

  it('prefix search uses text_pattern_ops index path (fail on pure Seq Scan)', async () => {
    const escaped = escapeAdminUserLikePattern(prefixUser.toLowerCase());
    const pattern = `${escaped}%`;

    const opclass = await db.execute(sql`
      SELECT i.relname AS indexname, opc.opcname
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_opclass opc ON opc.oid = ANY (ix.indclass)
      WHERE t.relname = 'users'
        AND i.relname IN (
          'users_email_lower_pattern_idx',
          'users_username_lower_pattern_idx',
          'users_normalized_email_lower_pattern_idx'
        )
    `);
    const opRows =
      (opclass as unknown as { rows?: Array<Record<string, unknown>> }).rows ??
      (Array.isArray(opclass) ? (opclass as unknown[]) : []);
    expect(opRows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(opRows)).toContain('text_pattern_ops');

    const result = await db.execute(sql`
      EXPLAIN (FORMAT TEXT)
      SELECT id FROM users
      WHERE lower(username) LIKE ${pattern} ESCAPE '\\'
      LIMIT 10
    `);
    // Assert plan shape only (do not print planText — may embed the bound pattern).
    const planText = JSON.stringify(result);
    const hasIndexPath = /Index Scan|Bitmap Index Scan|Index Only Scan/i.test(planText);
    const pureSeq =
      /Seq Scan/i.test(planText) && !/Index Scan|Bitmap Index Scan|Index Only Scan/i.test(planText);

    // Hard gate: pure Seq Scan is a failure at this cardinality/selectivity.
    expect(pureSeq).toBe(false);
    expect(hasIndexPath).toBe(true);
  });
});
