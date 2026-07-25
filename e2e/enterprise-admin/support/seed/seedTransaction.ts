/**
 * Seed principals + platform RBAC for the enterprise-admin suite.
 * Tracks created IDs and mutated globals for true CAS restore.
 */
import { randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';
import { Pool } from 'pg';

import {
  armCommitInFlight,
  clearCommitInFlightIfSettled,
  createDurableRestoreHandle,
  type DurableRestoreHandle,
  waitBarrierDir,
} from './commitLifecycle';
import {
  mapPermissionRow,
  mapRoleRow,
  rolePermissionLinkFingerprint,
  tsIso,
  userRoleLinkFingerprint,
} from './fingerprints';
import {
  createSuiteNamespace,
  makePrincipal,
  MANAGED_RESOURCES,
  nano,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  ROLE_PERMISSION_MAP,
} from './fixtureCatalog';
import { snapshotGlobalDbDigest } from './globalSnapshot';
import type {
  GlobalDbDigest,
  ManagedPolicyRow,
  PlatformPermissionRow,
  PlatformRoleRow,
  SuiteGlobalWriteManifest,
  SuitePrincipal,
  SuiteRolePermissionLink,
  SuiteSeed,
  SuiteUserRoleLink,
} from './types';

export const seedEnterpriseAdminSuite = async (
  databaseUrl: string,
  /** Prefer pre-registered handle so signal handlers see restore as soon as COMMIT lands. */
  durableRestoreHandle?: DurableRestoreHandle,
): Promise<{
  durableRestore: DurableRestoreHandle;
  globalBefore: GlobalDbDigest;
  manifest: SuiteGlobalWriteManifest;
  seed: SuiteSeed;
}> => {
  // Enter durable handle BEFORE first async work (fail-closed settlement always).
  const durableRestore = durableRestoreHandle ?? createDurableRestoreHandle(databaseUrl);
  durableRestore.databaseUrl = databaseUrl;

  try {
    return await seedEnterpriseAdminSuiteInner(databaseUrl, durableRestore);
  } finally {
    durableRestore.settled = true;
    durableRestore.markSettled();
  }
};

const seedEnterpriseAdminSuiteInner = async (
  databaseUrl: string,
  durableRestore: DurableRestoreHandle,
): Promise<{
  durableRestore: DurableRestoreHandle;
  globalBefore: GlobalDbDigest;
  manifest: SuiteGlobalWriteManifest;
  seed: SuiteSeed;
}> => {
  // Fail-closed early rejection after handle entry (tests); never leaves committed pollution.
  if (process.env.E2E_CAS_FORCE_EARLY_FAIL === '1') {
    throw new Error('forced early seed failure before transaction work');
  }

  const globalBefore = await snapshotGlobalDbDigest(databaseUrl);
  const beforePoliciesByResource = new Map(
    globalBefore.managedPolicies.map((p) => [p.resource, p] as const),
  );

  const namespace = createSuiteNamespace();
  const password = `E2e!${nano(8)}A1`;
  const ordinary = makePrincipal(namespace, 'ordinary', password);
  const owner = makePrincipal(namespace, 'owner', password);
  const superAdmin = makePrincipal(namespace, 'super_admin', password);
  const auditor = makePrincipal(namespace, 'auditor', password);
  const workspaceId = `ws_${namespace}`.slice(0, 32);
  const workspaceSlug = `ws-${namespace}`.slice(0, 80);
  const passwordHash = await bcrypt.hash(password, 10);
  const pool = new Pool({ connectionString: databaseUrl });
  // Single owned client for the full seed transaction (backend pid + in-flight COMMIT).
  const client = await pool.connect();
  // Suppress unhandled 'error' when lifecycle terminates this backend mid-COMMIT.
  client.on('error', () => undefined);
  const q = (text: string, params?: unknown[]) => client.query(text, params);
  const now = new Date().toISOString();
  const onboarding = JSON.stringify({ finishedAt: now, version: 1 });

  const createdPermissionIds: string[] = [];
  const createdRoleIds: string[] = [];
  const createdPolicyIds: string[] = [];
  /** Ownership ONLY from INSERT…RETURNING — never global before/after diff. */
  const createdRolePermissionKeys: SuiteRolePermissionLink[] = [];
  const createdUserRoles: SuiteUserRoleLink[] = [];
  const mutatedPolicies: SuiteGlobalWriteManifest['mutatedPolicies'] = [];
  /** roleId → name for RETURNING enrichment */
  const roleNameById = new Map<string, string>();
  const permCodeById = new Map<string, string>();

  try {
    await q('BEGIN');
    const pidRow = await q('SELECT pg_backend_pid() AS pid');
    durableRestore.ownedBackendPid = Number(pidRow.rows[0]?.pid ?? 0) || null;

    if (process.env.E2E_CAS_FORCE_TXN_ROLLBACK === '1') {
      throw new Error('forced mid-transaction rollback');
    }

    for (const code of PLATFORM_PERMISSIONS) {
      const category = code.split(':')[0] || 'platform';
      const candidateId = `perm_${nano(8)}`;
      const inserted = await q(
        `INSERT INTO rbac_permissions (id, code, name, category, description, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, $6)
         ON CONFLICT (code) DO NOTHING
         RETURNING id, code`,
        [candidateId, code, code, category, code, now],
      );
      if (inserted.rows[0]?.id) {
        createdPermissionIds.push(String(inserted.rows[0].id));
        permCodeById.set(String(inserted.rows[0].id), String(inserted.rows[0].code));
      } else {
        const existing = await q(`SELECT id, code FROM rbac_permissions WHERE code = $1 LIMIT 1`, [
          code,
        ]);
        if (existing.rows[0]?.id) {
          permCodeById.set(String(existing.rows[0].id), String(existing.rows[0].code));
        }
      }
    }

    const roleIds = new Map<string, string>();
    for (const roleName of PLATFORM_ROLES) {
      const candidateId = `role_${roleName}_${nano(4)}`;
      const inserted = await q(
        `INSERT INTO rbac_roles (id, name, display_name, description, is_system, is_active, metadata, workspace_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, true, '{}'::jsonb, NULL, $5, $5)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [candidateId, roleName, roleName, `platform ${roleName}`, now],
      );
      if (inserted.rows[0]?.id) {
        createdRoleIds.push(String(inserted.rows[0].id));
      }
      const found = await q(
        `SELECT id FROM rbac_roles WHERE name = $1 AND workspace_id IS NULL LIMIT 1`,
        [roleName],
      );
      if (!found.rows[0]?.id) throw new Error(`failed to seed platform role ${roleName}`);
      const id = found.rows[0].id as string;
      roleIds.set(roleName, id);
      roleNameById.set(id, roleName);

      for (const code of ROLE_PERMISSION_MAP[roleName]) {
        const perm = await q(`SELECT id FROM rbac_permissions WHERE code = $1 LIMIT 1`, [code]);
        const permissionId = perm.rows[0]?.id as string | undefined;
        if (!permissionId) continue;
        // Ownership ONLY from RETURNING — never claim pre-existing rows.
        const link = await q(
          `INSERT INTO rbac_role_permissions (role_id, permission_id, created_at)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING
           RETURNING role_id, permission_id, created_at`,
          [id, permissionId, now],
        );
        if (link.rows[0]) {
          const createdAt = tsIso(link.rows[0].created_at);
          const roleId = String(link.rows[0].role_id);
          const permId = String(link.rows[0].permission_id);
          const base = { createdAt, permissionId: permId, roleId };
          createdRolePermissionKeys.push({
            ...base,
            fingerprint: rolePermissionLinkFingerprint(base),
            permissionCode: permCodeById.get(permId) ?? code,
            roleName: roleNameById.get(roleId) ?? roleName,
          });
        }
      }
    }

    const insertUser = async (user: SuitePrincipal) => {
      await q(
        `INSERT INTO users (id, email, normalized_email, username, full_name, email_verified, onboarding, created_at, updated_at, last_active_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, $7, $7)
         ON CONFLICT (id) DO UPDATE SET onboarding = $6, updated_at = $7`,
        [
          user.id,
          user.email,
          user.email.toLowerCase(),
          user.username,
          user.fullName,
          onboarding,
          now,
        ],
      );
      await q(
        `INSERT INTO accounts (id, user_id, account_id, provider_id, password, created_at, updated_at)
         VALUES ($1, $2, $3, 'credential', $4, $5, $5)
         ON CONFLICT (id) DO UPDATE SET password = $4, updated_at = $5`,
        [user.accountId, user.id, user.email, passwordHash, now],
      );
    };

    for (const user of [ordinary, owner, superAdmin, auditor]) {
      await insertUser(user);
    }

    const assignUserRole = async (params: {
      roleId: string;
      userId: string;
      workspaceId: null | string;
    }) => {
      const linkId = randomUUID();
      // RETURN every stored column (id, user_id, role_id, workspace_id, created_at, expires_at).
      const inserted = await q(
        `INSERT INTO rbac_user_roles (id, user_id, role_id, workspace_id, created_at, expires_at)
         VALUES ($1::uuid, $2, $3, $4, $5, NULL)
         ON CONFLICT DO NOTHING
         RETURNING id, user_id, role_id, workspace_id, created_at, expires_at`,
        [linkId, params.userId, params.roleId, params.workspaceId, now],
      );
      if (inserted.rows[0]) {
        const row = inserted.rows[0];
        const base = {
          createdAt: tsIso(row.created_at),
          expiresAt: row.expires_at == null ? null : tsIso(row.expires_at),
          id: String(row.id),
          roleId: String(row.role_id),
          userId: String(row.user_id),
          workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
        };
        createdUserRoles.push({
          ...base,
          fingerprint: userRoleLinkFingerprint(base),
        });
      }
    };

    const assignGlobal = async (userId: string, roleName: string) => {
      const roleId = roleIds.get(roleName);
      if (!roleId) throw new Error(`missing platform role ${roleName}`);
      await assignUserRole({ roleId, userId, workspaceId: null });
    };

    await assignGlobal(superAdmin.id, 'super_admin');
    await assignGlobal(auditor.id, 'auditor');

    await q(
      `INSERT INTO workspaces (id, slug, name, description, primary_owner_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (id) DO NOTHING`,
      [workspaceId, workspaceSlug, `E2E WS ${namespace}`, 'enterprise-admin e2e', owner.id, now],
    );

    const ownerRoleCandidate = `role_ws_owner_${nano(4)}`;
    await q(
      `INSERT INTO rbac_roles (id, name, display_name, description, is_system, is_active, workspace_id, created_at, updated_at)
       VALUES ($1, 'workspace_owner', 'Workspace Owner', 'workspace owner', true, true, $2, $3, $3)
       ON CONFLICT DO NOTHING`,
      [ownerRoleCandidate, workspaceId, now],
    );
    const ownerRole = await q(
      `SELECT id FROM rbac_roles WHERE name = 'workspace_owner' AND workspace_id = $1 LIMIT 1`,
      [workspaceId],
    );
    const resolvedOwnerRoleId = ownerRole.rows[0]?.id as string | undefined;
    if (!resolvedOwnerRoleId) throw new Error('workspace_owner role seed failed');
    await assignUserRole({
      roleId: resolvedOwnerRoleId,
      userId: owner.id,
      workspaceId,
    });

    // Managed policies: INSERT when missing. Mutate skills only when needed, with before/after CAS.
    for (const resource of MANAGED_RESOURCES) {
      const managed = resource === 'skills';
      const item = { enforcementMode: managed ? 'enforced' : 'observe', managed };
      const config = JSON.stringify({ draft: item, published: item });
      const policyId = `pmrp_${resource}_${nano(4)}`;
      const inserted = await q(
        `INSERT INTO platform_managed_resource_policies
           (id, resource, status, revision, enforcement, config, created_at, updated_at)
         VALUES ($1, $2, 'published', 1, $3, $4::jsonb, $5, $5)
         ON CONFLICT (resource) DO NOTHING
         RETURNING id`,
        [policyId, resource, managed ? 'enforced' : 'observe', config, now],
      );
      if (inserted.rows[0]?.id) {
        createdPolicyIds.push(String(inserted.rows[0].id));
      }
    }

    // Skills must be managed+enforced for fail-closed tests.
    const skillsBefore = beforePoliciesByResource.get('skills');
    const skillsCurrent = await q(
      `SELECT id, resource, status, revision, enforcement, config::text AS config
         FROM platform_managed_resource_policies WHERE resource = 'skills' LIMIT 1`,
    );
    if (skillsCurrent.rows[0]) {
      const cur: ManagedPolicyRow = {
        config: String(skillsCurrent.rows[0].config ?? ''),
        enforcement: String(skillsCurrent.rows[0].enforcement ?? ''),
        id: String(skillsCurrent.rows[0].id),
        resource: 'skills',
        revision: Number(skillsCurrent.rows[0].revision),
        status: String(skillsCurrent.rows[0].status),
      };
      const managedTrue =
        cur.config.includes('"managed":true') || cur.config.includes('"managed": true');
      const needsMutation = cur.enforcement !== 'enforced' || !managedTrue;
      if (needsMutation && skillsBefore && !createdPolicyIds.includes(cur.id)) {
        const desiredConfig = JSON.stringify({
          draft: { enforcementMode: 'enforced', managed: true },
          published: { enforcementMode: 'enforced', managed: true },
        });
        const updated = await q(
          `UPDATE platform_managed_resource_policies
              SET status = 'published',
                  revision = GREATEST(revision, 1),
                  enforcement = 'enforced',
                  config = $2::jsonb,
                  updated_at = $1
            WHERE id = $3 AND resource = 'skills'
            RETURNING id, resource, status, revision, enforcement, config::text AS config`,
          [now, desiredConfig, cur.id],
        );
        if (updated.rows[0]) {
          const after: ManagedPolicyRow = {
            config: String(updated.rows[0].config ?? ''),
            enforcement: String(updated.rows[0].enforcement ?? ''),
            id: String(updated.rows[0].id),
            resource: 'skills',
            revision: Number(updated.rows[0].revision),
            status: String(updated.rows[0].status),
          };
          mutatedPolicies.push({ after, before: skillsBefore });
        }
      }
    }

    // Pre-COMMIT journal: full after-state for created rows (same txn, visible uncommitted).
    const createdPermIdSet = new Set(createdPermissionIds);
    const createdRoleIdSet = new Set(createdRoleIds);
    const createdPolicyIdSet = new Set(createdPolicyIds);

    let createdPermissions: PlatformPermissionRow[] = [];
    let createdRoles: PlatformRoleRow[] = [];
    if (createdPermIdSet.size > 0) {
      const permRows = await q(
        `SELECT id, code, name, category, description, is_active, created_at, updated_at
           FROM rbac_permissions WHERE id = ANY($1::text[])`,
        [[...createdPermIdSet]],
      );
      createdPermissions = permRows.rows.map((r) => mapPermissionRow(r as Record<string, unknown>));
    }
    if (createdRoleIdSet.size > 0) {
      const roleRows = await q(
        `SELECT id, name, display_name, description, is_system, is_active, workspace_id,
                metadata, created_at, updated_at
           FROM rbac_roles WHERE id = ANY($1::text[]) AND workspace_id IS NULL`,
        [[...createdRoleIdSet]],
      );
      createdRoles = roleRows.rows.map((r) => mapRoleRow(r as Record<string, unknown>));
    }

    const policyRows = await q(
      `SELECT id, resource, status, revision, enforcement, config::text AS config
         FROM platform_managed_resource_policies
        WHERE id = ANY($1::text[]) OR resource = ANY($2::text[])`,
      [[...createdPolicyIdSet], MANAGED_RESOURCES],
    );
    const createdPolicies: ManagedPolicyRow[] = policyRows.rows
      .filter((r) => createdPolicyIdSet.has(String(r.id)))
      .map((row) => ({
        config: String(row.config ?? ''),
        enforcement: String(row.enforcement ?? ''),
        id: String(row.id),
        resource: String(row.resource),
        revision: Number(row.revision),
        status: String(row.status),
      }));

    // Link ownership is ONLY createdRolePermissionKeys / createdUserRoles from INSERT RETURNING.
    // Never re-derive ownership from a global table before/after diff.

    const suiteSeed: SuiteSeed = {
      auditor,
      namespace,
      ordinary,
      owner,
      superAdmin,
      workspaceId,
      workspaceSlug,
    };

    // Lightweight after digest for journal (roles/perms ids only for GlobalDbDigest equality)
    const afterLite: GlobalDbDigest = {
      managedPolicies: policyRows.rows.map((row) => ({
        config: String(row.config ?? ''),
        enforcement: String(row.enforcement ?? ''),
        id: String(row.id),
        resource: String(row.resource),
        revision: Number(row.revision),
        status: String(row.status),
      })),
      platformPermissions: [
        ...globalBefore.platformPermissions,
        ...createdPermissions.map((p) => ({ code: p.code, id: p.id })),
      ],
      platformRolePermissions: [
        ...globalBefore.platformRolePermissions,
        ...createdRolePermissionKeys.map((l) => ({
          permissionCode: l.permissionCode,
          permissionId: l.permissionId,
          roleId: l.roleId,
          roleName: l.roleName,
        })),
      ],
      platformRoles: [
        ...globalBefore.platformRoles,
        ...createdRoles.map((r) => ({ id: r.id, name: r.name })),
      ],
    };

    const journal: SuiteGlobalWriteManifest = {
      after: afterLite,
      before: globalBefore,
      createdPermissions,
      createdPolicies,
      createdRolePermissionKeys,
      createdRoles,
      createdUserRoles,
      mutatedPolicies,
    };

    // Publish journal on handle BEFORE COMMIT so signal after COMMIT has restorable state.
    durableRestore.manifest = journal;
    durableRestore.seed = suiteSeed;

    // Optional deferred-commit probe (tests only): insert row that fires DEFERRABLE trigger at COMMIT.
    if (
      process.env.E2E_CAS_COMMIT_DEFERRED_RAISE === '1' ||
      process.env.E2E_CAS_COMMIT_DEFERRED_SLEEP_MS
    ) {
      await q(
        `INSERT INTO e2e_cas_commit_probe (id, note) VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note`,
        [process.env.E2E_CAS_COMMIT_DEFERRED_SLEEP_MS || 'raise'],
      );
      if (process.env.E2E_CAS_COMMIT_DEFERRED_SLEEP_MS) {
        await q(`SELECT set_config('e2e.cas_commit_sleep_ms', $1, true)`, [
          process.env.E2E_CAS_COMMIT_DEFERRED_SLEEP_MS,
        ]);
      }
      if (process.env.E2E_CAS_COMMIT_DEFERRED_RAISE === '1') {
        await q(`SELECT set_config('e2e.cas_commit_mode', 'raise', true)`);
      } else {
        await q(`SELECT set_config('e2e.cas_commit_mode', 'sleep', true)`);
      }
    }

    // Mark COMMIT issued synchronously IMMEDIATELY before sending the real COMMIT query.
    durableRestore.commitPhase = 'commitIssued';
    const hangAfterIssue = process.env.E2E_CAS_COMMIT_ISSUED_MARKER_DIR;
    if (hangAfterIssue) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        `${hangAfterIssue}/commit-issued`,
        String(durableRestore.ownedBackendPid ?? ''),
        'utf8',
      );
    }

    const commitPromise = q('COMMIT');
    armCommitInFlight(durableRestore, commitPromise);

    try {
      await commitPromise;
      clearCommitInFlightIfSettled(durableRestore);

      // Server COMMIT completed successfully (or deferred path allowed it).
      // Optionally withhold client arm so lifecycle must reconcile landed after-state.
      if (process.env.E2E_CAS_COMMIT_LANDED_CLIENT_UNKNOWN === '1') {
        durableRestore.commitPhase = 'ambiguous';
        durableRestore.committed = false;
        const hangDir = process.env.E2E_CAS_COMMIT_LANDED_HANG_DIR;
        if (hangDir) {
          await waitBarrierDir(hangDir, 'commit-landed', 120_000);
        }
        throw new Error(
          'server COMMIT landed but client result withheld (ambiguous; journal restorable)',
        );
      }

      // Synchronous arm — no await between COMMIT resolve and committed=true (default path).
      durableRestore.commitPhase = 'committed';
      durableRestore.committed = true;
    } catch (commitError) {
      clearCommitInFlightIfSettled(durableRestore);
      // COMMIT rejected after being issued (e.g. deferred RAISE) — never infer rolledBack without reconcile.
      if (durableRestore.commitPhase !== 'committed') {
        durableRestore.commitPhase = 'ambiguous';
        durableRestore.committed = false;
      }
      throw commitError;
    }
  } catch (error) {
    const phase = durableRestore.commitPhase;
    if (phase === 'notStarted') {
      await q('ROLLBACK').catch(() => undefined);
      durableRestore.commitPhase = 'rolledBack';
      durableRestore.manifest = null;
      durableRestore.seed = null;
      durableRestore.committed = false;
    } else if (phase === 'commitIssued') {
      // In-flight or just-finished without arm: keep journal; do not ROLLBACK if already decided.
      const inflight: Promise<unknown> | null = durableRestore.commitInFlight;
      if (inflight && durableRestore.commitInFlightPending) {
        // Do not unbounded-await here if outer cleanup owns resolution; best-effort short wait only.
        // Leave pending reference intact for reconcile refuse if still in flight.
        await Promise.race([
          inflight.catch(() => undefined),
          new Promise<void>((r) => setTimeout(r, 50)),
        ]);
        clearCommitInFlightIfSettled(durableRestore);
      } else {
        clearCommitInFlightIfSettled(durableRestore);
      }
      if (durableRestore.commitPhase !== 'committed') {
        durableRestore.commitPhase = 'ambiguous';
      }
    } else if (phase === 'ambiguous') {
      // Keep journal; best-effort rollback only if txn still open.
      await q('ROLLBACK').catch(() => undefined);
    } else if (phase === 'committed') {
      // Post-commit errors must not clear restorable journal.
    } else {
      await q('ROLLBACK').catch(() => undefined);
    }
    throw error;
  } finally {
    try {
      client.release();
    } catch {
      // connection may be terminated
    }
    await pool.end().catch(() => undefined);
  }
  if (!durableRestore.manifest || !durableRestore.seed) {
    throw new Error('seed completed without durable journal');
  }

  // Optional hang after arm (tests force deadlock / pre-ready signal while restorable).
  const barrierDir = process.env.E2E_CAS_POST_COMMIT_BARRIER_DIR;
  if (barrierDir) {
    const { writeFileSync, existsSync } = await import('node:fs');
    writeFileSync(`${barrierDir}/post-commit`, '1', 'utf8');
    const release = `${barrierDir}/release`;
    const deadline = Date.now() + 60_000;
    while (!existsSync(release) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Optional forced post-commit reporting failure (journal already restorable).
  if (process.env.E2E_CAS_FORCE_POST_COMMIT_FAIL === '1') {
    throw new Error('forced post-COMMIT reporting failure (journal remains restorable)');
  }

  // Best-effort post-commit full digest refresh (may fail without losing restore).
  try {
    const after = await snapshotGlobalDbDigest(databaseUrl);
    durableRestore.manifest = {
      ...durableRestore.manifest,
      after,
    };
  } catch {
    // journal remains valid
  }

  return {
    durableRestore,
    globalBefore,
    manifest: durableRestore.manifest,
    seed: durableRestore.seed,
  };
};
