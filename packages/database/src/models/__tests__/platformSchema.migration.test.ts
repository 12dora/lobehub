// @vitest-environment node
/**
 * Migration smoke — every enterprise platform_* (and user_setting_*) table exported
 * from the Drizzle schema must exist in the migrated test database (DB-011).
 *
 * Does not exercise publish / audit / job domain logic.
 */
import { getTableName, is, sql, Table } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import * as platformSchemas from '../../schemas/platform';
import { platformAuditLogs, platformJobs, platformResourceRevisions } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';

/** Derive the authoritative enterprise table list from exported Drizzle table configs. */
export const expectedEnterpriseTableNames = (): string[] => {
  const names = new Set<string>();
  for (const value of Object.values(platformSchemas)) {
    if (is(value, Table)) {
      names.add(getTableName(value));
    }
  }
  return [...names].toSorted();
};

const serverDB: LobeChatDatabase = await getTestDB();

afterEach(async () => {
  // TRUNCATE bypasses revision/audit immutability triggers (migration 0145).
  // Scoped to tables this file inserts into — not a shared-worker wipe of all platform_*.
  await serverDB.execute(
    sql.raw(`
      TRUNCATE TABLE
        platform_resource_revisions,
        platform_audit_logs,
        platform_jobs,
        platform_setting_policies,
        platform_branding
      CASCADE
    `),
  );
});

describe('platform Migration 0 tables', () => {
  it('exposes all platform_* / user_setting_* tables from the Drizzle schema', async () => {
    const expected = expectedEnterpriseTableNames();
    // Guard: schema export drift — currently 45 enterprise tables.
    expect(expected.length).toBeGreaterThanOrEqual(45);
    expect(
      expected.every((name) => name.startsWith('platform_') || name.startsWith('user_setting')),
    ).toBe(true);

    const result = await serverDB.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (
          table_name LIKE 'platform_%'
          OR table_name LIKE 'user_setting%'
        )
      ORDER BY table_name
    `);

    const rows =
      (result as unknown as { rows?: { table_name: string }[] }).rows ??
      (result as unknown as { table_name: string }[]);
    const names = (Array.isArray(rows) ? rows : []).map(
      (r: { table_name: string }) => r.table_name,
    );

    // Exact equality: every Drizzle enterprise table must be present; no silent omissions.
    expect(names).toEqual(expect.arrayContaining(expected));
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it('accepts inserts into M01 core tables', async () => {
    const [rev] = await serverDB
      .insert(platformResourceRevisions)
      .values({
        resourceType: 'branding',
        resourceId: 'singleton',
        revision: 1,
        status: 'draft',
        payload: { displayName: 'AIHub' },
        checksum: 'abc',
      })
      .returning();
    expect(rev.id).toMatch(/^prev_/);

    const [audit] = await serverDB
      .insert(platformAuditLogs)
      .values({
        action: 'platform.schema.smoke',
        targetType: 'branding',
        targetId: 'singleton',
        result: 'success',
      })
      .returning();
    expect(audit.id).toMatch(/^paud_/);

    const [job] = await serverDB
      .insert(platformJobs)
      .values({
        type: 'platform.schema.smoke',
        idempotencyKey: 'smoke-1',
      })
      .returning();
    expect(job.id).toMatch(/^pjob_/);
    expect(job.status).toBe('pending');
  });

  it('enforces revision uniqueness on (resource_type, resource_id, revision)', async () => {
    await serverDB.insert(platformResourceRevisions).values({
      resourceType: 'branding',
      resourceId: 'singleton',
      revision: 1,
      status: 'published',
      payload: {},
      checksum: 'x',
    });

    await expect(
      serverDB.insert(platformResourceRevisions).values({
        resourceType: 'branding',
        resourceId: 'singleton',
        revision: 1,
        status: 'published',
        payload: {},
        checksum: 'y',
      }),
    ).rejects.toThrow();
  });

  it('enforces job idempotency uniqueness on (type, idempotency_key)', async () => {
    await serverDB.insert(platformJobs).values({
      type: 'platform.schema.smoke',
      idempotencyKey: 'dup-key',
    });

    await expect(
      serverDB.insert(platformJobs).values({
        type: 'platform.schema.smoke',
        idempotencyKey: 'dup-key',
      }),
    ).rejects.toThrow();
  });
});
