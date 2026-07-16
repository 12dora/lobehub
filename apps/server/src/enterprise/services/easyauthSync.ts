/**
 * Sync EasyAuth grants → local snapshot + global rbac_user_roles (M02).
 * Idempotent. Never modifies super_admin or workspace roles.
 *
 * Does **not** re-seed platform roles on the hot path (M3) — call
 * ensurePlatformRbacSeeded / bootstrap at startup.
 */
import { eq } from 'drizzle-orm';

import { AIHUB_ACCESS_PERMISSION } from '@/const/platform/permissions';
import {
  EASYAUTH_GROUP_TO_ROLE,
  EASYAUTH_PERMISSION_TO_ROLE,
  type EasyauthManagedRoleName,
  PLATFORM_SYSTEM_ROLES,
} from '@/const/platform/roles';
import { EasyauthGrantSnapshotModel } from '@/database/models/platform/easyauthGrantSnapshot';
import { PlatformJobModel } from '@/database/models/platform/job';
import { RbacModel } from '@/database/models/rbac';
import { account } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { getGlobalRoleIdsByName } from '@/database/utils/seedPlatformRoles';

import { parseEasyauthConfig } from '../config/easyauth';
import {
  EasyauthClientError,
  EasyauthPermissionClient,
  type EasyauthPermissionSnapshot,
} from './easyauthClient';
import { PlatformAuditService } from './platformAudit';

export const EASYAUTH_SYNC_JOB_TYPE = 'platform.easyauth.sync_user';

export interface SyncUserEasyauthResult {
  accessGranted: boolean;
  degraded: boolean;
  grantVersion: number | null;
  rolesApplied: string[];
  source: 'easyauth' | 'cache' | 'super_admin_bypass' | 'skipped' | 'unchanged';
}

const resolveExternalUserId = async (
  db: LobeChatDatabase,
  userId: string,
  explicit?: string | null,
): Promise<string | null> => {
  if (explicit) return explicit;

  const rows = await db
    .select({
      accountId: account.accountId,
      providerId: account.providerId,
    })
    .from(account)
    .where(eq(account.userId, userId));

  const preferred = rows.find((r) => /authentik|oidc|sso|dingtalk/i.test(r.providerId));
  if (preferred?.accountId) return preferred.accountId;
  if (rows[0]?.accountId) return rows[0].accountId;
  return null;
};

/**
 * Map EasyAuth snapshot → managed local role names.
 * Only authorization group keys and aihub.role.* / aihub.access markers —
 * fine-grained platform_* codes are intentionally ignored (M4).
 */
export const deriveManagedRolesFromSnapshot = (
  snapshot: EasyauthPermissionSnapshot,
): EasyauthManagedRoleName[] => {
  const roles = new Set<EasyauthManagedRoleName>();

  for (const group of snapshot.groups) {
    const mapped = EASYAUTH_GROUP_TO_ROLE[group.key];
    if (mapped) roles.add(mapped);
  }

  for (const grant of snapshot.grants) {
    const mapped = EASYAUTH_PERMISSION_TO_ROLE[grant.permission];
    if (mapped) roles.add(mapped);
  }

  return [...roles];
};

export const snapshotHasAccess = (snapshot: EasyauthPermissionSnapshot): boolean => {
  if (snapshot.grants.some((g) => g.permission === AIHUB_ACCESS_PERMISSION)) return true;
  return deriveManagedRolesFromSnapshot(snapshot).length > 0;
};

export class EasyauthSyncService {
  private readonly snapshots: EasyauthGrantSnapshotModel;
  private readonly rbac: RbacModel;
  private readonly audit: PlatformAuditService;
  private readonly client: EasyauthPermissionClient;
  private readonly jobs: PlatformJobModel;

  constructor(
    private readonly db: LobeChatDatabase,
    options?: { client?: EasyauthPermissionClient },
  ) {
    this.snapshots = new EasyauthGrantSnapshotModel(db);
    this.rbac = new RbacModel(db, 'system');
    this.audit = new PlatformAuditService(db);
    this.client = options?.client ?? new EasyauthPermissionClient();
    this.jobs = new PlatformJobModel(db);
  }

  /**
   * Sync one user. Super admins skip EasyAuth (break-glass).
   * Same grant_version + non-degraded cache short-circuits (M8/minor).
   */
  syncUser = async (params: {
    actorUserId?: string | null;
    externalUserId?: string | null;
    force?: boolean;
    reason?: string;
    userId: string;
  }): Promise<SyncUserEasyauthResult> => {
    if (await this.rbac.isGlobalSuperAdmin(params.userId)) {
      return {
        accessGranted: true,
        degraded: false,
        grantVersion: null,
        rolesApplied: [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN],
        source: 'super_admin_bypass',
      };
    }

    const externalUserId = await resolveExternalUserId(
      this.db,
      params.userId,
      params.externalUserId,
    );

    if (!externalUserId) {
      const cached = await this.snapshots.findByUser(params.userId, this.client.appKey);
      return {
        accessGranted: cached?.accessGranted ?? false,
        degraded: cached?.degraded ?? false,
        grantVersion: cached?.grantVersion ?? null,
        rolesApplied: [],
        source: cached ? 'cache' : 'skipped',
      };
    }

    let snapshot: EasyauthPermissionSnapshot;
    let degraded = false;

    try {
      snapshot = await this.client.fetchPermissionSnapshot(externalUserId);
    } catch (error) {
      const message = error instanceof EasyauthClientError ? error.message : 'EasyAuth sync failed';
      const cached = await this.snapshots.markDegraded(params.userId, message, this.client.appKey);
      if (cached) {
        snapshot = {
          app_key: cached.appKey,
          catalog_version: cached.catalogVersion,
          expires_at: cached.expiresAt?.toISOString(),
          grant_version: cached.grantVersion,
          grants: (cached.grants as EasyauthPermissionSnapshot['grants']) ?? [],
          groups: (cached.groups as EasyauthPermissionSnapshot['groups']) ?? [],
          snapshot_version: cached.snapshotVersion,
          user_id: cached.externalUserId,
        };
        degraded = true;
      } else {
        return {
          accessGranted: false,
          degraded: true,
          grantVersion: null,
          rolesApplied: [],
          source: 'cache',
        };
      }
    }

    // Short-circuit when grant_version unchanged and cache is healthy (unless force).
    if (!params.force && !degraded) {
      const prior = await this.snapshots.findByUser(params.userId, this.client.appKey);
      if (
        prior &&
        !prior.degraded &&
        prior.grantVersion === snapshot.grant_version &&
        prior.snapshotVersion === snapshot.snapshot_version
      ) {
        return {
          accessGranted: prior.accessGranted,
          degraded: false,
          grantVersion: prior.grantVersion,
          rolesApplied: (await this.rbac.getGlobalUserRoles(params.userId)).map((r) => r.name),
          source: 'unchanged',
        };
      }
    }

    const accessGranted = snapshotHasAccess(snapshot);
    const managedRoles = deriveManagedRolesFromSnapshot(snapshot);
    if (accessGranted && !managedRoles.includes(PLATFORM_SYSTEM_ROLES.PLATFORM_USER)) {
      managedRoles.push(PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
    }

    await this.snapshots.upsert({
      accessGranted,
      appKey: this.client.appKey,
      catalogVersion: snapshot.catalog_version,
      degraded,
      expiresAt: snapshot.expires_at ? new Date(snapshot.expires_at) : null,
      externalUserId,
      grantVersion: snapshot.grant_version,
      grants: snapshot.grants,
      groups: snapshot.groups,
      lastError: degraded ? 'using_cached_snapshot' : null,
      snapshotVersion: snapshot.snapshot_version,
      userId: params.userId,
    });

    const roleIdsByName = await getGlobalRoleIdsByName(this.db, managedRoles);
    const roleIds = managedRoles
      .map((name) => roleIdsByName.get(name))
      .filter((id): id is string => Boolean(id));

    await this.rbac.replaceGlobalUserRoles(params.userId, roleIds, {
      preserveRoleNames: [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN],
      // EasyAuth path never removes super_admin; last-super protect still applies.
      protectLastSuperAdmin: true,
    });

    await this.audit.append({
      action: 'platform.easyauth.sync',
      actorUserId: params.actorUserId ?? params.userId,
      afterDiff: {
        accessGranted,
        degraded,
        grantVersion: snapshot.grant_version,
        roles: managedRoles,
      },
      reason: params.reason ?? 'easyauth_sync',
      result: degraded ? 'failure' : 'success',
      targetId: params.userId,
      targetType: 'user',
    });

    return {
      accessGranted,
      degraded,
      grantVersion: snapshot.grant_version,
      rolesApplied: managedRoles,
      source: degraded ? 'cache' : 'easyauth',
    };
  };

  /**
   * Fire-and-forget login hook entry (safe to call from Better Auth session create).
   * Errors are swallowed after mark-degraded path inside syncUser.
   */
  syncUserOnLogin = async (userId: string): Promise<void> => {
    try {
      await this.syncUser({ reason: 'login', userId });
    } catch {
      // Never block login on EasyAuth failures.
    }
  };

  /**
   * Enqueue a platform job for periodic / batch EasyAuth sync of one user.
   */
  enqueueUserSyncJob = async (params: { requestedBy?: string | null; userId: string }) => {
    return this.jobs.enqueue({
      idempotencyKey: `easyauth-sync:${params.userId}:${Date.now()}`,
      input: { userId: params.userId },
      maxAttempts: 3,
      requestedBy: params.requestedBy ?? null,
      type: EASYAUTH_SYNC_JOB_TYPE,
    });
  };

  getSyncStatus = async (userId?: string) => {
    const config = parseEasyauthConfig();
    if (userId) {
      const snap = await this.snapshots.findByUser(userId, config.appKey);
      return {
        appKey: config.appKey,
        baseUrl: config.baseUrl,
        hasToken: Boolean(config.appToken),
        user: snap
          ? {
              accessGranted: snap.accessGranted,
              degraded: snap.degraded,
              fetchedAt: snap.fetchedAt?.toISOString() ?? null,
              grantVersion: snap.grantVersion,
              lastError: snap.lastError,
              snapshotVersion: snap.snapshotVersion,
            }
          : null,
      };
    }

    return {
      appKey: config.appKey,
      baseUrl: config.baseUrl,
      hasToken: Boolean(config.appToken),
      user: null,
    };
  };
}

/**
 * Standalone login-time sync for Better Auth hooks (no TRPC).
 * Dynamically construct service; never throws.
 */
export const runEasyauthSyncOnLogin = async (
  db: LobeChatDatabase,
  userId: string,
): Promise<void> => {
  const service = new EasyauthSyncService(db);
  await service.syncUserOnLogin(userId);
};
