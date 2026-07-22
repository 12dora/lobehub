/**
 * Sync EasyAuth grants → local snapshot + global rbac_user_roles (M02).
 * Idempotent. Never modifies super_admin or workspace roles.
 *
 * Does **not** re-seed platform roles on the hot path (M3) — call
 * ensurePlatformRbacSeeded / bootstrap at startup.
 */
import { eq } from 'drizzle-orm';

import { AIHUB_ACCESS_PERMISSION } from '@/const/platform/permissions';
import type { EasyauthManagedRoleName } from '@/const/platform/roles';
import {
  EASYAUTH_GROUP_TO_ROLE,
  EASYAUTH_PERMISSION_TO_ROLE,
  PLATFORM_SYSTEM_ROLES,
} from '@/const/platform/roles';
import { EasyauthGrantSnapshotModel } from '@/database/models/platform/easyauthGrantSnapshot';
import { PlatformJobModel } from '@/database/models/platform/job';
import { RbacModel } from '@/database/models/rbac';
import { account } from '@/database/schemas';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import { getGlobalRoleIdsByName } from '@/database/utils/seedPlatformRoles';

import { parseEasyauthConfig } from '../config/easyauth';
import { containsEnterpriseSecretMaterial } from '../security/redaction';
import type { EasyauthPermissionSnapshot } from './easyauthClient';
import { EasyauthPermissionClient } from './easyauthClient';
import type { CreatePlatformAuditLogParams } from './platformAudit';
import { PlatformAuditService } from './platformAudit';

export const EASYAUTH_SYNC_JOB_TYPE = 'platform.easyauth.sync_user';

export interface SyncUserEasyauthResult {
  accessGranted: boolean;
  degraded: boolean;
  grantVersion: number | null;
  rolesApplied: string[];
  source: 'easyauth' | 'cache' | 'super_admin_bypass' | 'skipped' | 'unchanged';
}

export interface SyncUserEasyauthParams {
  actorUserId?: string | null;
  externalUserId?: string | null;
  force?: boolean;
  reason?: string;
  userId: string;
}

interface NormalizedSyncUserEasyauthParams extends SyncUserEasyauthParams {
  reason: string;
}

type EasyauthAuditDatabase = LobeChatDatabase | Transaction;

export type EasyauthAuditWriter = (
  db: EasyauthAuditDatabase,
  params: CreatePlatformAuditLogParams,
) => Promise<void>;

export class EasyauthSyncAuditError extends Error {
  readonly code = 'PLATFORM_EASYAUTH_AUDIT_UNAVAILABLE' as const;

  constructor() {
    super('PLATFORM_EASYAUTH_AUDIT_UNAVAILABLE');
    this.name = 'EasyauthSyncAuditError';
  }
}

export class EasyauthSyncReasonError extends Error {
  readonly code = 'PLATFORM_EASYAUTH_INVALID_REASON' as const;

  constructor() {
    super('PLATFORM_EASYAUTH_INVALID_REASON');
    this.name = 'EasyauthSyncReasonError';
  }
}

const DEFAULT_SYNC_REASON = 'easyauth_sync';
const INVALID_REASON_AUDIT_REASON = 'easyauth_sync_invalid_reason';
const MAX_SYNC_REASON_LENGTH = 2000;

export const normalizeEasyauthSyncReason = (reason: string | undefined): string => {
  if (reason === undefined) return DEFAULT_SYNC_REASON;
  const normalized = reason.trim();
  if (
    !normalized ||
    normalized.length > MAX_SYNC_REASON_LENGTH ||
    containsEnterpriseSecretMaterial(normalized)
  ) {
    throw new EasyauthSyncReasonError();
  }
  return normalized;
};

const defaultEasyauthAuditWriter: EasyauthAuditWriter = async (db, params) => {
  await new PlatformAuditService(db).append(params);
};

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

  // Credential accounts are LOCAL identities (accountId = local user id) —
  // never send them to EasyAuth as external subject ids. Credential-only users
  // resolve to null, which callers treat as a clean skip (cache / skipped).
  const external = rows.filter((r) => r.providerId !== 'credential');
  const preferred = external.find((r) => /authentik|oidc|sso|dingtalk/i.test(r.providerId));
  if (preferred?.accountId) return preferred.accountId;
  if (external[0]?.accountId) return external[0].accountId;
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
  private readonly auditWriter: EasyauthAuditWriter;
  private readonly client: EasyauthPermissionClient;
  private readonly jobs: PlatformJobModel;

  constructor(
    private readonly db: LobeChatDatabase,
    options?: { auditWriter?: EasyauthAuditWriter; client?: EasyauthPermissionClient },
  ) {
    this.snapshots = new EasyauthGrantSnapshotModel(db);
    this.rbac = new RbacModel(db, 'system');
    this.auditWriter = options?.auditWriter ?? defaultEasyauthAuditWriter;
    this.client = options?.client ?? new EasyauthPermissionClient();
    this.jobs = new PlatformJobModel(db);
  }

  private appendSyncOutcome = async (
    db: EasyauthAuditDatabase,
    params: Pick<NormalizedSyncUserEasyauthParams, 'actorUserId' | 'reason' | 'userId'>,
    outcome: SyncUserEasyauthResult,
  ): Promise<void> => {
    try {
      await this.auditWriter(db, {
        action: 'platform.easyauth.sync',
        actorUserId: params.actorUserId ?? params.userId,
        afterDiff: {
          accessGranted: outcome.accessGranted,
          degraded: outcome.degraded,
          grantVersion: outcome.grantVersion,
          roles: outcome.rolesApplied,
          source: outcome.source,
        },
        reason: params.reason,
        result: outcome.degraded || outcome.source === 'skipped' ? 'failure' : 'success',
        targetId: params.userId,
        targetType: 'user',
      });
    } catch {
      throw new EasyauthSyncAuditError();
    }
  };

  private recordSyncOutcome = async (
    params: NormalizedSyncUserEasyauthParams,
    outcome: SyncUserEasyauthResult,
  ): Promise<void> => {
    await this.appendSyncOutcome(this.db, params, outcome);
  };

  private recordSyncFailure = async (
    params: Pick<NormalizedSyncUserEasyauthParams, 'actorUserId' | 'reason' | 'userId'>,
  ): Promise<void> => {
    try {
      await this.auditWriter(this.db, {
        action: 'platform.easyauth.sync',
        actorUserId: params.actorUserId ?? params.userId,
        afterDiff: { source: 'failed' },
        reason: params.reason,
        result: 'failure',
        targetId: params.userId,
        targetType: 'user',
      });
    } catch (auditError) {
      console.error('[easyauthSync] failure audit unavailable', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
  };

  private persistSyncOutcome = async (
    params: NormalizedSyncUserEasyauthParams,
    input: {
      degraded: boolean;
      externalUserId: string;
      managedRoles: EasyauthManagedRoleName[];
      outcome: SyncUserEasyauthResult;
      snapshot: EasyauthPermissionSnapshot;
    },
  ): Promise<void> => {
    await this.db.transaction(async (tx) => {
      await new EasyauthGrantSnapshotModel(tx).upsert({
        accessGranted: input.outcome.accessGranted,
        appKey: this.client.appKey,
        catalogVersion: input.snapshot.catalog_version,
        degraded: input.degraded,
        expiresAt: input.snapshot.expires_at ? new Date(input.snapshot.expires_at) : null,
        externalUserId: input.externalUserId,
        grantVersion: input.snapshot.grant_version,
        grants: input.snapshot.grants,
        groups: input.snapshot.groups,
        lastError: input.degraded ? 'using_cached_snapshot' : null,
        snapshotVersion: input.snapshot.snapshot_version,
        userId: params.userId,
      });

      const roleIdsByName = await getGlobalRoleIdsByName(tx, input.managedRoles);
      const roleIds = input.managedRoles
        .map((name) => roleIdsByName.get(name))
        .filter((id): id is string => Boolean(id));
      const txRbac = new RbacModel(tx as LobeChatDatabase, 'system');
      await txRbac.replaceGlobalUserRoles(params.userId, roleIds, {
        preserveRoleNames: [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN],
        // EasyAuth path never removes super_admin; last-super protect still applies.
        protectLastSuperAdmin: true,
      });

      await this.appendSyncOutcome(tx, params, input.outcome);
    });
  };

  /**
   * Sync one user. Super admins skip EasyAuth (break-glass).
   * Same grant_version + non-degraded cache short-circuits (M8/minor).
   */
  private syncUserInternal = async (
    params: NormalizedSyncUserEasyauthParams,
  ): Promise<SyncUserEasyauthResult> => {
    if (await this.rbac.isGlobalSuperAdmin(params.userId)) {
      const outcome = {
        accessGranted: true,
        degraded: false,
        grantVersion: null,
        rolesApplied: [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN],
        source: 'super_admin_bypass' as const,
      };
      await this.recordSyncOutcome(params, outcome);
      return outcome;
    }

    const externalUserId = await resolveExternalUserId(
      this.db,
      params.userId,
      params.externalUserId,
    );

    if (!externalUserId) {
      const cached = await this.snapshots.findByUser(params.userId, this.client.appKey);
      const outcome = {
        accessGranted: cached?.accessGranted ?? false,
        degraded: cached?.degraded ?? false,
        grantVersion: cached?.grantVersion ?? null,
        rolesApplied: [],
        source: cached ? ('cache' as const) : ('skipped' as const),
      };
      await this.recordSyncOutcome(params, outcome);
      return outcome;
    }

    let snapshot: EasyauthPermissionSnapshot;
    let degraded = false;

    try {
      snapshot = await this.client.fetchPermissionSnapshot(externalUserId);
    } catch {
      const cached = await this.snapshots.findByUser(params.userId, this.client.appKey);
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
        const outcome = {
          accessGranted: false,
          degraded: true,
          grantVersion: null,
          rolesApplied: [],
          source: 'cache' as const,
        };
        await this.recordSyncOutcome(params, outcome);
        return outcome;
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
        const outcome = {
          accessGranted: prior.accessGranted,
          degraded: false,
          grantVersion: prior.grantVersion,
          rolesApplied: (await this.rbac.getGlobalUserRoles(params.userId)).map((r) => r.name),
          source: 'unchanged' as const,
        };
        await this.recordSyncOutcome(params, outcome);
        return outcome;
      }
    }

    const accessGranted = snapshotHasAccess(snapshot);
    const managedRoles = deriveManagedRolesFromSnapshot(snapshot);
    if (accessGranted && !managedRoles.includes(PLATFORM_SYSTEM_ROLES.PLATFORM_USER)) {
      managedRoles.push(PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
    }

    const outcome = {
      accessGranted,
      degraded,
      grantVersion: snapshot.grant_version,
      rolesApplied: managedRoles,
      source: degraded ? ('cache' as const) : ('easyauth' as const),
    };
    await this.persistSyncOutcome(params, {
      degraded,
      externalUserId,
      managedRoles,
      outcome,
      snapshot,
    });
    return outcome;
  };

  syncUser = async (params: SyncUserEasyauthParams): Promise<SyncUserEasyauthResult> => {
    let normalizedParams: NormalizedSyncUserEasyauthParams;
    try {
      normalizedParams = { ...params, reason: normalizeEasyauthSyncReason(params.reason) };
    } catch (error) {
      await this.recordSyncFailure({ ...params, reason: INVALID_REASON_AUDIT_REASON });
      throw error;
    }

    try {
      return await this.syncUserInternal(normalizedParams);
    } catch (error) {
      if (!(error instanceof EasyauthSyncAuditError)) {
        await this.recordSyncFailure(normalizedParams);
      }
      throw error;
    }
  };

  /**
   * Fire-and-forget login hook entry (safe to call from Better Auth session create).
   * Errors are swallowed after syncUser's transactional degraded/failure handling.
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
