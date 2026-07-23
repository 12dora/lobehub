// @vitest-environment node
/**
 * PR-005: Migration 0 smoke — platform tables exist and accept empty inserts.
 * Does not exercise publish / audit / job domain logic (those land in PR-006+).
 */
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAuditLogs, platformJobs, platformResourceRevisions } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';

const serverDB: LobeChatDatabase = await getTestDB();

afterEach(async () => {
  // TRUNCATE bypasses revision/audit immutability triggers (migration 0145).
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
  it('exposes all platform_* tables in information_schema', async () => {
    const result = await serverDB.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (
          table_name LIKE 'platform_%'
          OR table_name = 'user_setting_overrides'
        )
      ORDER BY table_name
    `);

    const rows =
      (result as unknown as { rows?: { table_name: string }[] }).rows ??
      (result as unknown as { table_name: string }[]);
    const names = (Array.isArray(rows) ? rows : []).map(
      (r: { table_name: string }) => r.table_name,
    );

    expect(names).toEqual(
      expect.arrayContaining([
        'platform_agent_assignments',
        'platform_agent_versions',
        'platform_agents',
        'platform_ai_models',
        'platform_ai_providers',
        'platform_audit_logs',
        'platform_branding',
        'platform_connector_tools',
        'platform_connectors',
        'platform_identity_providers',
        'platform_jobs',
        'platform_managed_resource_policies',
        'platform_resource_revisions',
        'platform_setting_policies',
        'platform_skill_versions',
        'platform_skills',
        'platform_user_connector_bindings',
        'user_setting_overrides',
      ]),
    );
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
