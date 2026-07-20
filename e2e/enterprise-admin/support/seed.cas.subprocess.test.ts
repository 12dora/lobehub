/**
 * Real SIGINT/SIGTERM CAS restore coverage with independent subprocess + isolated DB.
 * Each case owns its own ParadeDB container — no cross-test pollution.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      createdPerm.description,
    ]);
    await pool2.end();

    const { cleanupEnterpriseAdminSuite } = await import('./seed');
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(
      digestFingerprint(before),
    );
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

    it(`real ${signal} in COMMIT→arm window restores exact before digest`, async () => {
      const harness = await startCasPostgres();
      cleanups.push(harness.stop);
      const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));

      const dir = mkdtempSync(path.join(tmpdir(), 'cas-pre-ready-'));
      const barrierDir = path.join(dir, 'barrier');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(barrierDir, { recursive: true });
      const beforeFpFile = path.join(dir, 'before.fp');
      const postCommit = path.join(barrierDir, 'post-commit');
      const release = path.join(barrierDir, 'release');

      const child = spawn('bun', [CHILD], {
        cwd: PROJECT,
        detached: true,
        env: {
          ...process.env,
          CAS_BEFORE_FP_FILE: beforeFpFile,
          CAS_DATABASE_URL: harness.databaseUrl,
          E2E_CAS_POST_COMMIT_BARRIER_DIR: barrierDir,
          // no CAS_READY_FILE — we signal before ready/seed-return
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
      // Committed pollution present before arm
      expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).not.toBe(
        beforeFp,
      );

      // Signal BEFORE release/arm (pre-ready)
      child.kill(signal);
      // Allow seed path to finish arm so hook can restore, then release if still waiting
      writeFileSync(release, '1', 'utf8');

      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 45_000);
      });

      // Parent independently proves full before digest restored
      expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);

      rmSync(dir, { force: true, recursive: true });
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    }, 120_000);
  }
});
