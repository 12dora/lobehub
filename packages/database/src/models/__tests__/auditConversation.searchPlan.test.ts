// @vitest-environment node
/**
 * EXPLAIN plan evidence that audit user prefix search uses lower(field) text_pattern_ops
 * indexes (DB-007). Mirrors adminUser.searchPlan.test.ts.
 *
 * Run: TEST_SERVER_DB=1 DATABASE_TEST_URL=... bunx vitest run src/models/__tests__/auditConversation.searchPlan.test.ts
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { escapeLike } from '../../repositories/platformSearch';
import { users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';

const isServerDB = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);

describe.skipIf(!isServerDB)('audit user prefix search EXPLAIN (TEST_SERVER_DB=1)', () => {
  let db: LobeChatDatabase;
  const prefixUser = 'audit_explain_prefix_user_unique';

  beforeEach(async () => {
    db = await getTestDB();
    await db.delete(users).where(sql`${users.id} like 'audit-explain-%'`);
    const rows = Array.from({ length: 800 }, (_, i) => ({
      email: `audit-explain-bulk-${i}@example.com`,
      id: `audit-explain-bulk-${i}`,
      normalizedEmail: `audit-explain-bulk-${i}@example.com`,
      username: `audit_explain_bulk_${i}`,
    }));
    rows.push({
      email: `${prefixUser}@example.com`,
      id: 'audit-explain-hit',
      normalizedEmail: `${prefixUser}@example.com`,
      username: prefixUser,
    });
    for (let i = 0; i < rows.length; i += 100) {
      await db.insert(users).values(rows.slice(i, i + 100));
    }
    await db.execute(sql`ANALYZE users`);
  });

  afterEach(async () => {
    if (!db) return;
    await db.delete(users).where(sql`${users.id} like 'audit-explain-%'`);
  });

  it('prefix search uses text_pattern_ops index path (fail on pure Seq Scan)', async () => {
    const pattern = `${escapeLike(prefixUser.toLowerCase())}%`;

    const result = await db.execute(sql`
      EXPLAIN (FORMAT TEXT)
      SELECT id FROM users
      WHERE lower(username) LIKE ${pattern} ESCAPE '\\'
         OR lower(email) LIKE ${pattern} ESCAPE '\\'
         OR lower("normalized_email") LIKE ${pattern} ESCAPE '\\'
      LIMIT 10
    `);
    const planText = JSON.stringify(result);
    const hasIndexPath = /Index Scan|Bitmap Index Scan|Index Only Scan/i.test(planText);
    const pureSeq =
      /Seq Scan/i.test(planText) && !/Index Scan|Bitmap Index Scan|Index Only Scan/i.test(planText);

    expect(pureSeq).toBe(false);
    expect(hasIndexPath).toBe(true);
  });
});
