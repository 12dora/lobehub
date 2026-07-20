/**
 * Real SIGINT/SIGTERM CAS restore coverage with independent subprocess + isolated DB.
 * Each case owns its own ParadeDB container — no cross-test pollution.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  casRestoreGlobalDb,
  digestFingerprint,
  seedEnterpriseAdminSuite,
  snapshotGlobalDbDigest,
} from './seed';
import { startCasPostgres } from './seed.casHarness';

const PROJECT = path.resolve(__dirname, '../../..');
const CHILD = path.join(__dirname, '../scripts/cas-signal-child.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('CAS real signal subprocess + foreign concurrent links', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const stop = cleanups.pop()!;
      await stop().catch(() => undefined);
    }
  });

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

  it('FOR UPDATE race: concurrent user_role insert cannot cascade-delete unnoticed', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const roleId = manifest.createdRoles[0].id;
    const foreignUserId = 'user_race_foreign';
    const suiteUserIds = [seed.ordinary.id, seed.owner.id, seed.superAdmin.id, seed.auditor.id];

    const poolSetup = new Pool({ connectionString: harness.databaseUrl });
    // Drop suite-owned principal links so CAS reaches FOR UPDATE on created roles.
    await poolSetup.query(`DELETE FROM rbac_user_roles WHERE user_id = ANY($1::text[])`, [
      suiteUserIds,
    ]);
    await poolSetup.query(
      `INSERT INTO users (id, email, normalized_email, username, full_name, email_verified, onboarding, created_at, updated_at, last_active_at)
       VALUES ($1, 'race@test', 'race@test', 'race', 'Race', true, '{}', NOW(), NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [foreignUserId],
    );
    await poolSetup.end();

    let lockedResolve!: () => void;
    const locked = new Promise<void>((r) => {
      lockedResolve = r;
    });
    let proceedResolve!: () => void;
    const proceed = new Promise<void>((r) => {
      proceedResolve = r;
    });

    const poolB = new Pool({ connectionString: harness.databaseUrl });
    let insertError: unknown;
    const insertPromise = (async () => {
      await locked;
      try {
        await poolB.query(`SET lock_timeout = '2s'`);
        await poolB.query(
          `INSERT INTO rbac_user_roles (id, user_id, role_id, workspace_id, created_at)
           VALUES ($1::uuid, $2, $3, NULL, NOW())`,
          [randomUUID(), foreignUserId, roleId],
        );
      } catch (error) {
        insertError = error;
      }
    })();

    // Restore holds FOR UPDATE then pauses — concurrent insert blocks or times out.
    // After we proceed, DELETE either sees no committed foreign link or refuses if inserted.
    const restorePromise = casRestoreGlobalDb(harness.databaseUrl, manifest, {
      afterRoleLocked: async (id) => {
        if (id === roleId) {
          lockedResolve();
          await proceed;
        }
      },
    });

    await locked;
    // Give conn B a moment to hit lock_timeout while A holds FOR UPDATE
    await sleep(500);
    proceedResolve();

    // Either restore succeeds (insert blocked/failed) or refuses foreign link
    let restoreError: unknown;
    try {
      await restorePromise;
    } catch (error) {
      restoreError = error;
    }
    await insertPromise;
    await poolB.end();

    // No unnoticed cascade: if insert committed, restore must have refused and link remains
    const poolCheck = new Pool({ connectionString: harness.databaseUrl });
    const links = await poolCheck.query(
      `SELECT 1 FROM rbac_user_roles WHERE role_id = $1 AND user_id = $2`,
      [roleId, foreignUserId],
    );
    if (links.rows.length > 0) {
      expect(restoreError).toBeTruthy();
      expect(String(restoreError)).toMatch(/foreign user_role|CAS restore conflict/);
      await poolCheck.query(`DELETE FROM rbac_user_roles WHERE user_id = $1`, [foreignUserId]);
    } else {
      // insert blocked/failed; restore should have completed or failed for other reasons
      expect(insertError || !restoreError).toBeTruthy();
    }
    await poolCheck.query(`DELETE FROM users WHERE id = $1`, [foreignUserId]);
    await poolCheck.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest).catch(async () => {
      const p = new Pool({ connectionString: harness.databaseUrl });
      await p.query(`DELETE FROM rbac_user_roles WHERE user_id = ANY($1::text[])`, [
        [seed.ordinary.id, seed.owner.id, seed.superAdmin.id, seed.auditor.id, foreignUserId],
      ]);
      await p.end();
    });
    void before;
  }, 90_000);

  it('FOR UPDATE race: concurrent role_permission insert cannot cascade-delete unnoticed', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const before = await snapshotGlobalDbDigest(harness.databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);
    const permissionId = manifest.createdPermissions[0].id;
    const foreignRoleId = 'role_race_foreign_perm';
    const suiteUserIds = [seed.ordinary.id, seed.owner.id, seed.superAdmin.id, seed.auditor.id];

    const poolSetup = new Pool({ connectionString: harness.databaseUrl });
    // Clear suite user_roles so role CAS can finish and reach permission FOR UPDATE.
    await poolSetup.query(`DELETE FROM rbac_user_roles WHERE user_id = ANY($1::text[])`, [
      suiteUserIds,
    ]);
    await poolSetup.query(
      `INSERT INTO rbac_roles (id, name, display_name, description, is_system, is_active, metadata, workspace_id, created_at, updated_at)
       VALUES ($1, 'race_foreign_role', 'Race', 'x', false, true, '{}'::jsonb, NULL, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [foreignRoleId],
    );
    await poolSetup.end();

    let lockedResolve!: () => void;
    const locked = new Promise<void>((r) => {
      lockedResolve = r;
    });
    let proceedResolve!: () => void;
    const proceed = new Promise<void>((r) => {
      proceedResolve = r;
    });

    const poolB = new Pool({ connectionString: harness.databaseUrl });
    let insertError: unknown;
    const insertPromise = (async () => {
      await locked;
      try {
        await poolB.query(`SET lock_timeout = '2s'`);
        await poolB.query(
          `INSERT INTO rbac_role_permissions (role_id, permission_id) VALUES ($1, $2)`,
          [foreignRoleId, permissionId],
        );
      } catch (error) {
        insertError = error;
      }
    })();

    const restorePromise = casRestoreGlobalDb(harness.databaseUrl, manifest, {
      afterPermissionLocked: async (id) => {
        if (id === permissionId) {
          lockedResolve();
          await proceed;
        }
      },
    });

    await Promise.race([
      locked,
      sleep(15_000).then(() => {
        throw new Error('permission FOR UPDATE barrier never reached');
      }),
    ]);
    await sleep(500);
    proceedResolve();

    let restoreError: unknown;
    try {
      await restorePromise;
    } catch (error) {
      restoreError = error;
    }
    await insertPromise;
    await poolB.end();

    const poolCheck = new Pool({ connectionString: harness.databaseUrl });
    const links = await poolCheck.query(
      `SELECT 1 FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [foreignRoleId, permissionId],
    );
    if (links.rows.length > 0) {
      expect(restoreError).toBeTruthy();
      expect(String(restoreError)).toMatch(/foreign role_permission|CAS restore conflict/);
      await poolCheck.query(
        `DELETE FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`,
        [foreignRoleId, permissionId],
      );
    } else {
      expect(insertError || !restoreError).toBeTruthy();
    }
    await poolCheck.query(`DELETE FROM rbac_roles WHERE id = $1`, [foreignRoleId]);
    await poolCheck.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest).catch(async () => {
      const p = new Pool({ connectionString: harness.databaseUrl });
      await p.query(`DELETE FROM rbac_role_permissions WHERE role_id = $1`, [foreignRoleId]);
      await p.query(`DELETE FROM rbac_roles WHERE id = $1`, [foreignRoleId]);
      await p.end();
    });
    void before;
  }, 90_000);

  it('early seed failure before transaction settles without committed pollution', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    const { createDurableRestoreHandle } = await import('./seed');
    const durable = createDurableRestoreHandle(harness.databaseUrl);
    process.env.E2E_CAS_FORCE_EARLY_FAIL = '1';
    try {
      await expect(seedEnterpriseAdminSuite(harness.databaseUrl, durable)).rejects.toThrow(
        /forced early seed failure/,
      );
    } finally {
      delete process.env.E2E_CAS_FORCE_EARLY_FAIL;
    }
    expect(durable.settled).toBe(true);
    expect(durable.committed).toBe(false);
    expect(durable.manifest).toBeNull();
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);
    await durable.whenSettled;
  }, 60_000);

  it('mid-transaction rollback settles without committed pollution', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    const { createDurableRestoreHandle } = await import('./seed');
    const durable = createDurableRestoreHandle(harness.databaseUrl);
    process.env.E2E_CAS_FORCE_TXN_ROLLBACK = '1';
    try {
      await expect(seedEnterpriseAdminSuite(harness.databaseUrl, durable)).rejects.toThrow(
        /forced mid-transaction rollback/,
      );
    } finally {
      delete process.env.E2E_CAS_FORCE_TXN_ROLLBACK;
    }
    expect(durable.settled).toBe(true);
    expect(durable.committed).toBe(false);
    expect(durable.manifest).toBeNull();
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);
  }, 60_000);

  it('forced post-COMMIT reporting failure still leaves restorable journal', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    const {
      createDurableRestoreHandle,
      registerSeedRestoreOnLifecycle,
      cleanupEnterpriseAdminSuite,
    } = await import('./seed');
    const {
      createLifecycleState,
      createRunToken,
      installLifecycleSignalHandlers,
      cleanupLifecycle,
    } = await import('./lifecycle');

    const durable = createDurableRestoreHandle(harness.databaseUrl);
    const state = createLifecycleState(createRunToken());
    installLifecycleSignalHandlers(state);
    registerSeedRestoreOnLifecycle(state, durable);

    process.env.E2E_CAS_FORCE_POST_COMMIT_FAIL = '1';
    try {
      await expect(seedEnterpriseAdminSuite(harness.databaseUrl, durable)).rejects.toThrow(
        /forced post-COMMIT/,
      );
    } finally {
      delete process.env.E2E_CAS_FORCE_POST_COMMIT_FAIL;
    }
    expect(durable.committed).toBe(true);
    expect(durable.manifest).toBeTruthy();
    expect(durable.seed).toBeTruthy();
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, durable.seed!, durable.manifest!);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);
    state.preCleanupHooks.length = 0;
    await cleanupLifecycle(state).catch(() => undefined);
  }, 90_000);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`real ${signal} after ready restores exact before digest`, async () => {
      const harness = await startCasPostgres();
      cleanups.push(harness.stop);
      const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));

      const dir = mkdtempSync(path.join(tmpdir(), 'cas-sig-'));
      const readyFile = path.join(dir, 'ready');
      const beforeFpFile = path.join(dir, 'before.fp');

      const child = spawn('bun', [CHILD], {
        cwd: PROJECT,
        detached: true,
        env: {
          ...process.env,
          CAS_BEFORE_FP_FILE: beforeFpFile,
          CAS_DATABASE_URL: harness.databaseUrl,
          CAS_READY_FILE: readyFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const deadline = Date.now() + 60_000;
      while (!existsSync(readyFile) && Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`child exited early code=${child.exitCode}`);
        }
        await sleep(200);
      }
      expect(existsSync(readyFile)).toBe(true);
      expect(readFileSync(beforeFpFile, 'utf8')).toBe(beforeFp);
      expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).not.toBe(
        beforeFp,
      );

      child.kill(signal);
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 30_000);
      });

      expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);

      rmSync(dir, { force: true, recursive: true });
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    }, 120_000);

    it(`real ${signal} on never-released post-COMMIT barrier restores without parent release`, async () => {
      const harness = await startCasPostgres();
      cleanups.push(harness.stop);
      const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));

      const dir = mkdtempSync(path.join(tmpdir(), 'cas-pre-ready-'));
      const barrierDir = path.join(dir, 'barrier');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(barrierDir, { recursive: true });
      const beforeFpFile = path.join(dir, 'before.fp');
      const postCommit = path.join(barrierDir, 'post-commit');
      // Intentionally NEVER write barrierDir/release — fail-closed restore must not need it.

      const child = spawn('bun', [CHILD], {
        cwd: PROJECT,
        detached: true,
        env: {
          ...process.env,
          CAS_BEFORE_FP_FILE: beforeFpFile,
          CAS_DATABASE_URL: harness.databaseUrl,
          E2E_CAS_POST_COMMIT_BARRIER_DIR: barrierDir,
          // no CAS_READY_FILE — signal while hung post-COMMIT
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const deadline = Date.now() + 60_000;
      while (!existsSync(postCommit) && Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`child exited early code=${child.exitCode}`);
        }
        await sleep(50);
      }
      expect(existsSync(postCommit)).toBe(true);
      expect(readFileSync(beforeFpFile, 'utf8')).toBe(beforeFp);
      expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).not.toBe(
        beforeFp,
      );

      const signalAt = Date.now();
      child.kill(signal);
      // Parent does NOT release the barrier — journal is already restorable after COMMIT.

      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 20_000);
      });

      const exitMs = Date.now() - signalAt;
      expect(exitMs).toBeLessThan(15_000);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      // Parent independently proves full before digest restored
      expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);

      rmSync(dir, { force: true, recursive: true });
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    }, 90_000);
  }
});
