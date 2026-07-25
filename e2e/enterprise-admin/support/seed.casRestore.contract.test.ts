/**
 * CAS restore contract tests: foreign links, field/timestamp drift, FOR UPDATE races,
 * and RETURNING-journal ownership. Each case owns its own ParadeDB container.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  casRestoreGlobalDb,
  digestFingerprint,
  seedEnterpriseAdminSuite,
  snapshotGlobalDbDigest,
} from './seed';
import { startCasPostgres } from './seed.casHarness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('CAS restore contracts (foreign concurrent links + drift)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const stop = cleanups.pop()!;
      await stop().catch(() => undefined);
    }
  }, 60_000);

  it('success path: seed + CAS restore returns exact before digest (self-cleaned)', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    expect(manifest.createdPermissions.length).toBeGreaterThan(0);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).not.toBe(
      digestFingerprint(before),
    );

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);

  it('foreign concurrent user_role on created role: refuse restore, link+role remain', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);

    // Pick a suite-created platform role and attach a foreign user_role
    const createdRole = manifest.createdRoles[0];
    expect(createdRole).toBeTruthy();
    const pool = new Pool({ connectionString: harness.databaseUrl });
    const foreignUserId = 'user_foreign_concurrent_cas';
    await pool.query(
      `INSERT INTO users (id, email, normalized_email, username, full_name, email_verified, onboarding, created_at, updated_at, last_active_at)
         VALUES ($1, 'foreign@test', 'foreign@test', 'foreign', 'Foreign', true, '{}', NOW(), NOW(), NOW())
         ON CONFLICT DO NOTHING`,
      [foreignUserId],
    );
    await pool.query(
      `INSERT INTO rbac_user_roles (id, user_id, role_id, workspace_id, created_at)
         VALUES ($1::uuid, $2, $3, NULL, NOW())`,
      [randomUUID(), foreignUserId, createdRole.id],
    );
    await pool.end();

    await expect(casRestoreGlobalDb(harness.databaseUrl, manifest)).rejects.toThrow(
      /foreign user_role|CAS restore conflict/,
    );

    // Role and foreign link must still exist
    const pool2 = new Pool({ connectionString: harness.databaseUrl });
    const role = await pool2.query(`SELECT id FROM rbac_roles WHERE id = $1`, [createdRole.id]);
    const link = await pool2.query(
      `SELECT user_id FROM rbac_user_roles WHERE role_id = $1 AND user_id = $2`,
      [createdRole.id, foreignUserId],
    );
    expect(role.rows).toHaveLength(1);
    expect(link.rows).toHaveLength(1);
    // Hygiene: remove foreign pollution without using broken CAS on that role
    await pool2.query(`DELETE FROM rbac_user_roles WHERE user_id = $1`, [foreignUserId]);
    await pool2.query(`DELETE FROM users WHERE id = $1`, [foreignUserId]);
    await pool2.end();

    // Restore with cleaned foreign deps
    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);

  it('foreign concurrent role_permission on created role: refuse restore, link remains', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const createdRole = manifest.createdRoles[0];
    expect(createdRole).toBeTruthy();

    const pool = new Pool({ connectionString: harness.databaseUrl });
    const foreignPermId = 'perm_foreign_cas_only';
    await pool.query(
      `INSERT INTO rbac_permissions (id, code, name, category, description, is_active, created_at, updated_at)
         VALUES ($1, 'platform_foreign:test:all', 'x', 'platform', 'x', true, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
      [foreignPermId],
    );
    await pool.query(
      `INSERT INTO rbac_role_permissions (role_id, permission_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
      [createdRole.id, foreignPermId],
    );
    await pool.end();

    await expect(casRestoreGlobalDb(harness.databaseUrl, manifest)).rejects.toThrow(
      /foreign role_permission|CAS restore conflict/,
    );

    const pool2 = new Pool({ connectionString: harness.databaseUrl });
    const link = await pool2.query(
      `SELECT 1 FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [createdRole.id, foreignPermId],
    );
    expect(link.rows).toHaveLength(1);
    await pool2.query(
      `DELETE FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [createdRole.id, foreignPermId],
    );
    await pool2.query(`DELETE FROM rbac_permissions WHERE id = $1`, [foreignPermId]);
    await pool2.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);

  it('non-key role field drift refuses restore and leaves role intact', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const createdRole = manifest.createdRoles[0];
    expect(createdRole).toBeTruthy();

    const pool = new Pool({ connectionString: harness.databaseUrl });
    await pool.query(
      `UPDATE rbac_roles SET display_name = 'FOREIGN_CONCURRENT_DISPLAY_NAME' WHERE id = $1`,
      [createdRole.id],
    );
    const afterDrift = await pool.query(`SELECT display_name FROM rbac_roles WHERE id = $1`, [
      createdRole.id,
    ]);
    expect(afterDrift.rows[0].display_name).toBe('FOREIGN_CONCURRENT_DISPLAY_NAME');
    await pool.end();

    await expect(casRestoreGlobalDb(harness.databaseUrl, manifest)).rejects.toThrow(
      /after-state drifted|CAS restore conflict/,
    );

    const pool2 = new Pool({ connectionString: harness.databaseUrl });
    const still = await pool2.query(`SELECT id, display_name FROM rbac_roles WHERE id = $1`, [
      createdRole.id,
    ]);
    expect(still.rows).toHaveLength(1);
    expect(still.rows[0].display_name).toBe('FOREIGN_CONCURRENT_DISPLAY_NAME');
    // Revert drift so cleanup can succeed
    await pool2.query(`UPDATE rbac_roles SET display_name = $2 WHERE id = $1`, [
      createdRole.id,
      createdRole.displayName,
    ]);
    await pool2.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);

  it('non-key permission field drift refuses restore and leaves permission intact', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const createdPerm = manifest.createdPermissions[0];
    expect(createdPerm).toBeTruthy();

    const pool = new Pool({ connectionString: harness.databaseUrl });
    await pool.query(
      `UPDATE rbac_permissions SET description = 'FOREIGN_CONCURRENT_DESCRIPTION' WHERE id = $1`,
      [createdPerm.id],
    );
    await pool.end();

    await expect(casRestoreGlobalDb(harness.databaseUrl, manifest)).rejects.toThrow(
      /after-state drifted|CAS restore conflict/,
    );

    const pool2 = new Pool({ connectionString: harness.databaseUrl });
    const still = await pool2.query(`SELECT id, description FROM rbac_permissions WHERE id = $1`, [
      createdPerm.id,
    ]);
    expect(still.rows).toHaveLength(1);
    expect(still.rows[0].description).toBe('FOREIGN_CONCURRENT_DESCRIPTION');
    await pool2.query(`UPDATE rbac_permissions SET description = $2 WHERE id = $1`, [
      createdPerm.id,
      createdPerm.description === '' ? null : createdPerm.description,
    ]);
    await pool2.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);

  it('role metadata drift refuses restore and leaves role intact', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const createdRole = manifest.createdRoles[0];
    const pool = new Pool({ connectionString: harness.databaseUrl });
    await pool.query(`UPDATE rbac_roles SET metadata = '{"foreign":true}'::jsonb WHERE id = $1`, [
      createdRole.id,
    ]);
    await pool.end();
    await expect(casRestoreGlobalDb(harness.databaseUrl, manifest)).rejects.toThrow(
      /after-state drifted|CAS restore conflict/,
    );
    const pool2 = new Pool({ connectionString: harness.databaseUrl });
    const still = await pool2.query(`SELECT id, metadata FROM rbac_roles WHERE id = $1`, [
      createdRole.id,
    ]);
    expect(still.rows).toHaveLength(1);
    expect(still.rows[0].metadata).toEqual({ foreign: true });
    await pool2.query(`UPDATE rbac_roles SET metadata = $2::jsonb WHERE id = $1`, [
      createdRole.id,
      createdRole.metadata,
    ]);
    await pool2.end();
    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);

  it('role timestamp-only drift refuses restore and leaves role intact', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const createdRole = manifest.createdRoles[0];
    const pool = new Pool({ connectionString: harness.databaseUrl });
    await pool.query(
      `UPDATE rbac_roles SET updated_at = created_at + interval '1 day' WHERE id = $1`,
      [createdRole.id],
    );
    await pool.end();
    await expect(casRestoreGlobalDb(harness.databaseUrl, manifest)).rejects.toThrow(
      /after-state drifted|CAS restore conflict/,
    );
    const pool2 = new Pool({ connectionString: harness.databaseUrl });
    const still = await pool2.query(`SELECT id FROM rbac_roles WHERE id = $1`, [createdRole.id]);
    expect(still.rows).toHaveLength(1);
    await pool2.query(`UPDATE rbac_roles SET updated_at = $2::timestamptz WHERE id = $1`, [
      createdRole.id,
      createdRole.updatedAt,
    ]);
    await pool2.end();
    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);

  it('permission timestamp-only drift refuses restore and leaves permission intact', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const createdPerm = manifest.createdPermissions[0];
    const pool = new Pool({ connectionString: harness.databaseUrl });
    await pool.query(
      `UPDATE rbac_permissions SET updated_at = created_at + interval '1 day' WHERE id = $1`,
      [createdPerm.id],
    );
    await pool.end();
    await expect(casRestoreGlobalDb(harness.databaseUrl, manifest)).rejects.toThrow(
      /after-state drifted|CAS restore conflict/,
    );
    const pool2 = new Pool({ connectionString: harness.databaseUrl });
    expect(
      (await pool2.query(`SELECT id FROM rbac_permissions WHERE id = $1`, [createdPerm.id])).rows,
    ).toHaveLength(1);
    await pool2.query(`UPDATE rbac_permissions SET updated_at = $2::timestamptz WHERE id = $1`, [
      createdPerm.id,
      createdPerm.updatedAt,
    ]);
    await pool2.end();
    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);

  it('FOR UPDATE race: committed foreign user_role forces restore refuse (unconditional)', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const roleId = manifest.createdRoles[0].id;
    const foreignUserId = 'user_race_foreign_b_first';
    const suiteUserIds = [seed.ordinary.id, seed.owner.id, seed.superAdmin.id, seed.auditor.id];
    const foreignLinkId = randomUUID();

    const poolSetup = new Pool({ connectionString: harness.databaseUrl });
    await poolSetup.query(`DELETE FROM rbac_user_roles WHERE user_id = ANY($1::text[])`, [
      suiteUserIds,
    ]);
    await poolSetup.query(
      `INSERT INTO users (id, email, normalized_email, username, full_name, email_verified, onboarding, created_at, updated_at, last_active_at)
       VALUES ($1, 'raceb@test', 'raceb@test', 'raceb', 'RaceB', true, '{}', NOW(), NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [foreignUserId],
    );
    await poolSetup.end();

    // B first: BEGIN + INSERT uncommitted (holds FK KEY SHARE on role parent).
    const poolB = new Pool({ connectionString: harness.databaseUrl });
    const clientB = await poolB.connect();
    await clientB.query('BEGIN');
    await clientB.query(
      `INSERT INTO rbac_user_roles (id, user_id, role_id, workspace_id, created_at)
       VALUES ($1::uuid, $2, $3, NULL, NOW())`,
      [foreignLinkId, foreignUserId, roleId],
    );
    // B insert succeeded (uncommitted)

    const appName = `cas_restore_role_${Date.now()}`;
    const restorePromise = casRestoreGlobalDb(harness.databaseUrl, manifest, {
      applicationName: appName,
    });

    // Deterministically prove A is waiting on the parent lock (not sleep-only).
    const observe = new Pool({ connectionString: harness.databaseUrl });
    const waitDeadline = Date.now() + 10_000;
    let waiting = false;
    while (Date.now() < waitDeadline) {
      const rows = await observe.query(
        `SELECT wait_event_type, wait_event, state, query
           FROM pg_stat_activity
          WHERE application_name = $1
            AND pid <> pg_backend_pid()`,
        [appName],
      );
      if (
        rows.rows.some(
          (r) =>
            r.wait_event_type === 'Lock' ||
            (typeof r.query === 'string' && /FOR UPDATE/i.test(r.query) && r.state === 'active'),
        )
      ) {
        waiting = true;
        break;
      }
      await sleep(50);
    }
    await observe.end();
    expect(waiting).toBe(true);

    // COMMIT B — foreign link becomes visible; A must observe and refuse.
    await clientB.query('COMMIT');
    clientB.release();
    await poolB.end();

    await expect(restorePromise).rejects.toThrow(/foreign user_role|CAS restore conflict/);

    const poolCheck = new Pool({ connectionString: harness.databaseUrl });
    const role = await poolCheck.query(`SELECT id FROM rbac_roles WHERE id = $1`, [roleId]);
    const links = await poolCheck.query(
      `SELECT id FROM rbac_user_roles WHERE id = $1::uuid AND role_id = $2 AND user_id = $3`,
      [foreignLinkId, roleId, foreignUserId],
    );
    expect(role.rows).toHaveLength(1);
    expect(links.rows).toHaveLength(1);
    await poolCheck.query(`DELETE FROM rbac_user_roles WHERE id = $1::uuid`, [foreignLinkId]);
    await poolCheck.query(`DELETE FROM users WHERE id = $1`, [foreignUserId]);
    await poolCheck.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
  }, 90_000);

  it('FOR UPDATE race: committed foreign role_permission forces restore refuse (unconditional)', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const permissionId = manifest.createdPermissions[0].id;
    const foreignRoleId = 'role_race_foreign_b_first';
    const suiteUserIds = [seed.ordinary.id, seed.owner.id, seed.superAdmin.id, seed.auditor.id];

    const poolSetup = new Pool({ connectionString: harness.databaseUrl });
    await poolSetup.query(`DELETE FROM rbac_user_roles WHERE user_id = ANY($1::text[])`, [
      suiteUserIds,
    ]);
    await poolSetup.query(
      `INSERT INTO rbac_roles (id, name, display_name, description, is_system, is_active, metadata, workspace_id, created_at, updated_at)
       VALUES ($1, 'race_foreign_role_b', 'RaceB', 'x', false, true, '{}'::jsonb, NULL, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [foreignRoleId],
    );
    await poolSetup.end();

    const poolB = new Pool({ connectionString: harness.databaseUrl });
    const clientB = await poolB.connect();
    await clientB.query('BEGIN');
    await clientB.query(
      `INSERT INTO rbac_role_permissions (role_id, permission_id, created_at)
       VALUES ($1, $2, NOW())`,
      [foreignRoleId, permissionId],
    );

    const appName = `cas_restore_perm_${Date.now()}`;
    const restorePromise = casRestoreGlobalDb(harness.databaseUrl, manifest, {
      applicationName: appName,
    });

    const observe = new Pool({ connectionString: harness.databaseUrl });
    const waitDeadline = Date.now() + 10_000;
    let waiting = false;
    while (Date.now() < waitDeadline) {
      const rows = await observe.query(
        `SELECT wait_event_type, wait_event, state, query
           FROM pg_stat_activity
          WHERE application_name = $1
            AND pid <> pg_backend_pid()`,
        [appName],
      );
      if (
        rows.rows.some(
          (r) =>
            r.wait_event_type === 'Lock' ||
            (typeof r.query === 'string' && /FOR UPDATE/i.test(r.query) && r.state === 'active'),
        )
      ) {
        waiting = true;
        break;
      }
      await sleep(50);
    }
    await observe.end();
    expect(waiting).toBe(true);

    await clientB.query('COMMIT');
    clientB.release();
    await poolB.end();

    await expect(restorePromise).rejects.toThrow(/foreign role_permission|CAS restore conflict/);

    const poolCheck = new Pool({ connectionString: harness.databaseUrl });
    const perm = await poolCheck.query(`SELECT id FROM rbac_permissions WHERE id = $1`, [
      permissionId,
    ]);
    const links = await poolCheck.query(
      `SELECT 1 FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [foreignRoleId, permissionId],
    );
    expect(perm.rows).toHaveLength(1);
    expect(links.rows).toHaveLength(1);
    await poolCheck.query(
      `DELETE FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [foreignRoleId, permissionId],
    );
    await poolCheck.query(`DELETE FROM rbac_roles WHERE id = $1`, [foreignRoleId]);
    await poolCheck.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
  }, 90_000);

  it('link ownership: foreign role_permission not in RETURNING journal survives cleanup refuse', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const createdRole = manifest.createdRoles[0];
    expect(createdRole).toBeTruthy();

    const foreignPermId = 'perm_foreign_not_in_journal';
    const pool = new Pool({ connectionString: harness.databaseUrl });
    await pool.query(
      `INSERT INTO rbac_permissions (id, code, name, category, description, is_active, created_at, updated_at)
       VALUES ($1, 'platform_foreign:journal:all', 'x', 'platform', 'x', true, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [foreignPermId],
    );
    await pool.query(
      `INSERT INTO rbac_role_permissions (role_id, permission_id, created_at) VALUES ($1, $2, NOW())`,
      [createdRole.id, foreignPermId],
    );
    // Foreign link must NOT be in suite manifest (RETURNING-only ownership)
    expect(
      manifest.createdRolePermissionKeys.some(
        (l) => l.roleId === createdRole.id && l.permissionId === foreignPermId,
      ),
    ).toBe(false);
    await pool.end();

    await expect(casRestoreGlobalDb(harness.databaseUrl, manifest)).rejects.toThrow(
      /foreign role_permission|CAS restore conflict/,
    );

    const pool2 = new Pool({ connectionString: harness.databaseUrl });
    const still = await pool2.query(
      `SELECT 1 FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [createdRole.id, foreignPermId],
    );
    expect(still.rows).toHaveLength(1);
    await pool2.query(
      `DELETE FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [createdRole.id, foreignPermId],
    );
    await pool2.query(`DELETE FROM rbac_permissions WHERE id = $1`, [foreignPermId]);
    await pool2.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);

  it('link ownership: delete+reinsert same role_permission key refuses CAS delete', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const suiteLink = manifest.createdRolePermissionKeys[0];
    expect(suiteLink).toBeTruthy();

    const pool = new Pool({ connectionString: harness.databaseUrl });
    await pool.query(
      `DELETE FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [suiteLink.roleId, suiteLink.permissionId],
    );
    // Reinsert same composite key with a new created_at (foreign reinsert)
    await pool.query(
      `INSERT INTO rbac_role_permissions (role_id, permission_id, created_at)
       VALUES ($1, $2, $3::timestamptz + interval '1 day')`,
      [suiteLink.roleId, suiteLink.permissionId, suiteLink.createdAt],
    );
    await pool.end();

    await expect(casRestoreGlobalDb(harness.databaseUrl, manifest)).rejects.toThrow(
      /created_at drifted|CAS restore conflict|after-state/,
    );

    const pool2 = new Pool({ connectionString: harness.databaseUrl });
    const still = await pool2.query(
      `SELECT created_at FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [suiteLink.roleId, suiteLink.permissionId],
    );
    expect(still.rows).toHaveLength(1);
    // Restore original created_at so cleanup can succeed
    await pool2.query(
      `UPDATE rbac_role_permissions SET created_at = $3::timestamptz
        WHERE role_id = $1 AND permission_id = $2`,
      [suiteLink.roleId, suiteLink.permissionId, suiteLink.createdAt],
    );
    await pool2.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);

  it('link ownership: delete+reinsert same user_role id with different full state refuses CAS', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const suiteLink = manifest.createdUserRoles[0];
    expect(suiteLink).toBeTruthy();

    const pool = new Pool({ connectionString: harness.databaseUrl });
    await pool.query(`DELETE FROM rbac_user_roles WHERE id = $1::uuid`, [suiteLink.id]);
    await pool.query(
      `INSERT INTO rbac_user_roles (id, user_id, role_id, workspace_id, created_at, expires_at)
       VALUES ($1::uuid, $2, $3, $4, $5::timestamptz + interval '2 days', NOW() + interval '30 days')`,
      [
        suiteLink.id,
        suiteLink.userId,
        suiteLink.roleId,
        suiteLink.workspaceId,
        suiteLink.createdAt,
      ],
    );
    await pool.end();

    await expect(casRestoreGlobalDb(harness.databaseUrl, manifest)).rejects.toThrow(
      /after-state drifted|CAS restore conflict|fingerprint/,
    );

    const pool2 = new Pool({ connectionString: harness.databaseUrl });
    expect(
      (await pool2.query(`SELECT id FROM rbac_user_roles WHERE id = $1::uuid`, [suiteLink.id]))
        .rows,
    ).toHaveLength(1);
    // Restore full after-state so cleanup can succeed
    await pool2.query(
      `UPDATE rbac_user_roles
          SET created_at = $2::timestamptz, expires_at = $3::timestamptz
        WHERE id = $1::uuid`,
      [suiteLink.id, suiteLink.createdAt, suiteLink.expiresAt],
    );
    await pool2.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);

  it('user_role expires_at-only drift refuses CAS and preserves link', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const suiteLink = manifest.createdUserRoles[0];
    expect(suiteLink).toBeTruthy();
    expect(suiteLink.expiresAt).toBeNull();

    const pool = new Pool({ connectionString: harness.databaseUrl });
    await pool.query(
      `UPDATE rbac_user_roles SET expires_at = NOW() + interval '7 days' WHERE id = $1::uuid`,
      [suiteLink.id],
    );
    await pool.end();

    await expect(casRestoreGlobalDb(harness.databaseUrl, manifest)).rejects.toThrow(
      /after-state drifted|CAS restore conflict|fingerprint/,
    );

    const pool2 = new Pool({ connectionString: harness.databaseUrl });
    const still = await pool2.query(
      `SELECT id, expires_at FROM rbac_user_roles WHERE id = $1::uuid`,
      [suiteLink.id],
    );
    expect(still.rows).toHaveLength(1);
    expect(still.rows[0].expires_at).not.toBeNull();
    await pool2.query(`UPDATE rbac_user_roles SET expires_at = NULL WHERE id = $1::uuid`, [
      suiteLink.id,
    ]);
    await pool2.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);

  it('foreign role→suite-user link not in RETURNING journal survives cleanup refuse', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const suiteUserId = seed.ordinary.id;
    const foreignRoleId = 'role_foreign_to_suite_user';

    const pool = new Pool({ connectionString: harness.databaseUrl });
    await pool.query(
      `INSERT INTO rbac_roles (id, name, display_name, description, is_system, is_active, metadata, workspace_id, created_at, updated_at)
       VALUES ($1, 'foreign_to_user', 'F', 'x', false, true, '{}'::jsonb, NULL, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [foreignRoleId],
    );
    const foreignLinkId = randomUUID();
    await pool.query(
      `INSERT INTO rbac_user_roles (id, user_id, role_id, workspace_id, created_at, expires_at)
       VALUES ($1::uuid, $2, $3, NULL, NOW(), NULL)`,
      [foreignLinkId, suiteUserId, foreignRoleId],
    );
    expect(manifest.createdUserRoles.some((l) => l.id === foreignLinkId)).toBe(false);
    await pool.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await expect(cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest)).rejects.toThrow(
      /non-owned user_role|CAS cleanup conflict|CAS restore conflict/,
    );

    const pool2 = new Pool({ connectionString: harness.databaseUrl });
    // Foreign link and suite user must still exist
    expect(
      (await pool2.query(`SELECT id FROM rbac_user_roles WHERE id = $1::uuid`, [foreignLinkId]))
        .rows,
    ).toHaveLength(1);
    expect(
      (await pool2.query(`SELECT id FROM users WHERE id = $1`, [suiteUserId])).rows,
    ).toHaveLength(1);
    await pool2.query(`DELETE FROM rbac_user_roles WHERE id = $1::uuid`, [foreignLinkId]);
    await pool2.query(`DELETE FROM rbac_roles WHERE id = $1`, [foreignRoleId]);
    await pool2.end();

    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
  }, 90_000);
});
