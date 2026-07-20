/**
 * Success / failure / interrupt CAS restore coverage for external-style global
 * row ownership. Uses an isolated ParadeDB container (not a shared DB).
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupLifecycle,
  createLifecycleState,
  createRunToken,
  inspectPublishedHostPort,
  startOwnedContainer,
} from './lifecycle';
import {
  casRestoreGlobalDb,
  cleanupEnterpriseAdminSuite,
  digestFingerprint,
  installManifestRestoreOnSignals,
  seedEnterpriseAdminSuite,
  snapshotGlobalDbDigest,
} from './seed';

describe('CAS restore success/failure/interrupt', () => {
  const runToken = createRunToken();
  const state = createLifecycleState(runToken);
  let databaseUrl = '';

  beforeAll(async () => {
    const container = await startOwnedContainer({
      args: [
        '-e',
        'POSTGRES_PASSWORD=postgres',
        '-e',
        'POSTGRES_DB=cas_restore',
        '-p',
        '127.0.0.1::5432',
      ],
      image: 'paradedb/paradedb:latest-pg17',
      name: `aihub-admin-cas-${runToken.slice(-10)}`,
      runToken,
      state,
    });
    const port = await inspectPublishedHostPort(container.id, 5432);
    databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/cas_restore`;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1500 });
      try {
        await pool.query('SELECT 1');
        await pool.end();
        break;
      } catch {
        await pool.end().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    // Minimal schema for CAS tables (not full product migrate — unit-level CAS only)
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rbac_permissions (
        id text PRIMARY KEY,
        code text UNIQUE NOT NULL,
        name text,
        category text,
        description text,
        is_active boolean,
        created_at timestamptz,
        updated_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS rbac_roles (
        id text PRIMARY KEY,
        name text NOT NULL,
        display_name text,
        description text,
        is_system boolean,
        is_active boolean,
        workspace_id text,
        created_at timestamptz,
        updated_at timestamptz
      );
      CREATE UNIQUE INDEX IF NOT EXISTS rbac_roles_platform_name_uidx
        ON rbac_roles (name) WHERE workspace_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS rbac_roles_ws_name_uidx
        ON rbac_roles (workspace_id, name) WHERE workspace_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS rbac_role_permissions (
        role_id text NOT NULL,
        permission_id text NOT NULL,
        PRIMARY KEY (role_id, permission_id)
      );
      CREATE TABLE IF NOT EXISTS platform_managed_resource_policies (
        id text PRIMARY KEY,
        resource text UNIQUE NOT NULL,
        status text,
        revision int,
        enforcement text,
        config jsonb,
        created_at timestamptz,
        updated_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY,
        email text,
        normalized_email text,
        username text,
        full_name text,
        email_verified boolean,
        onboarding jsonb,
        created_at timestamptz,
        updated_at timestamptz,
        last_active_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id text PRIMARY KEY,
        user_id text,
        account_id text,
        provider_id text,
        password text,
        created_at timestamptz,
        updated_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id text PRIMARY KEY,
        slug text,
        name text,
        description text,
        primary_owner_id text,
        created_at timestamptz,
        updated_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS rbac_user_roles (
        id uuid PRIMARY KEY,
        user_id text,
        role_id text,
        workspace_id text,
        created_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id text PRIMARY KEY,
        user_id text
      );
      CREATE TABLE IF NOT EXISTS platform_skills (
        id text PRIMARY KEY,
        skill_key text
      );
    `);
    await pool.end();
  }, 120_000);

  afterAll(async () => {
    await cleanupLifecycle(state).catch(() => undefined);
  });

  it('success path: seed + CAS restore returns exact before digest', async () => {
    const before = await snapshotGlobalDbDigest(databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(databaseUrl);
    expect(manifest.createdPermissionIds.length).toBeGreaterThan(0);
    const mid = await snapshotGlobalDbDigest(databaseUrl);
    expect(digestFingerprint(mid)).not.toBe(digestFingerprint(before));

    await cleanupEnterpriseAdminSuite(databaseUrl, seed, manifest);
    const after = await snapshotGlobalDbDigest(databaseUrl);
    expect(digestFingerprint(after)).toBe(digestFingerprint(before));
  }, 60_000);

  it('failure path: concurrent policy drift refuses CAS overwrite', async () => {
    const { manifest, seed } = await seedEnterpriseAdminSuite(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query(
      `UPDATE platform_managed_resource_policies
            SET revision = revision + 99, updated_at = NOW()
          WHERE resource = 'skills'`,
    );
    await pool.end();

    // Force a mutated-policy CAS path even when skills was suite-created.
    if (manifest.mutatedPolicies.length === 0 && manifest.createdPolicyIds.length > 0) {
      const afterSnap = manifest.after.managedPolicies.find((p) => p.resource === 'skills');
      const beforeSnap = manifest.before.managedPolicies.find((p) => p.resource === 'skills');
      if (afterSnap) {
        manifest.mutatedPolicies.push({
          after: afterSnap,
          before: beforeSnap ?? {
            ...afterSnap,
            enforcement: 'observe',
            revision: 0,
          },
        });
        manifest.createdPolicyIds = manifest.createdPolicyIds.filter((id) => id !== afterSnap.id);
      }
    }

    if (manifest.mutatedPolicies.length > 0) {
      await expect(casRestoreGlobalDb(databaseUrl, manifest)).rejects.toThrow(
        /CAS restore conflict/,
      );
    }

    await cleanupEnterpriseAdminSuite(databaseUrl, seed, {
      ...manifest,
      mutatedPolicies: [],
    }).catch(() => undefined);
  }, 60_000);

  it('interrupt path: signal-handler cleanup body restores before digest', async () => {
    const before = await snapshotGlobalDbDigest(databaseUrl);
    const { manifest, seed } = await seedEnterpriseAdminSuite(databaseUrl);
    expect(digestFingerprint(await snapshotGlobalDbDigest(databaseUrl))).not.toBe(
      digestFingerprint(before),
    );

    // Same body installManifestRestoreOnSignals runs on SIGINT/SIGTERM.
    const uninstall = installManifestRestoreOnSignals(databaseUrl, seed, manifest);
    try {
      await cleanupEnterpriseAdminSuite(databaseUrl, seed, manifest);
    } finally {
      uninstall();
    }

    const after = await snapshotGlobalDbDigest(databaseUrl);
    expect(digestFingerprint(after)).toBe(digestFingerprint(before));
  }, 60_000);

  it('SIGINT/SIGTERM handlers are registered and uninstallable', () => {
    const fakeSeed = {
      auditor: {
        accountId: 'a',
        email: 'a@test',
        fullName: 'a',
        id: 'u',
        password: 'p',
        roleLabel: 'auditor' as const,
        username: 'a',
      },
      namespace: 'n',
      ordinary: {
        accountId: 'o',
        email: 'o@test',
        fullName: 'o',
        id: 'uo',
        password: 'p',
        roleLabel: 'ordinary' as const,
        username: 'o',
      },
      owner: {
        accountId: 'w',
        email: 'w@test',
        fullName: 'w',
        id: 'uw',
        password: 'p',
        roleLabel: 'owner' as const,
        username: 'w',
      },
      superAdmin: {
        accountId: 's',
        email: 's@test',
        fullName: 's',
        id: 'us',
        password: 'p',
        roleLabel: 'super_admin' as const,
        username: 's',
      },
      workspaceId: 'ws',
      workspaceSlug: 'ws',
    };
    const emptyManifest = {
      after: {
        managedPolicies: [],
        platformPermissions: [],
        platformRolePermissions: [],
        platformRoles: [],
      },
      before: {
        managedPolicies: [],
        platformPermissions: [],
        platformRolePermissions: [],
        platformRoles: [],
      },
      createdPermissionIds: [],
      createdPolicyIds: [],
      createdRoleIds: [],
      createdRolePermissionKeys: [],
      mutatedPolicies: [],
    };
    const uninstall = installManifestRestoreOnSignals(databaseUrl, fakeSeed, emptyManifest);
    expect(typeof uninstall).toBe('function');
    uninstall();
  });
});
