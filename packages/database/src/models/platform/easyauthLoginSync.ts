/**
 * Login-time EasyAuth sync (path-boundary safe — no @/server/enterprise imports).
 * Used from Better Auth session.create hooks.
 *
 * Secrets: EASYAUTH_APP_TOKEN / EASYAUTH_APP_TOKEN_FILE only (never logged).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { eq } from 'drizzle-orm';

import { isEnterpriseFlagTruthy } from '@/const/platform/featureFlags';
import { AIHUB_ACCESS_PERMISSION } from '@/const/platform/permissions';
import {
  EASYAUTH_GROUP_TO_ROLE,
  EASYAUTH_PERMISSION_TO_ROLE,
  type EasyauthManagedRoleName,
  PLATFORM_SYSTEM_ROLES,
} from '@/const/platform/roles';

import { account } from '../../schemas/betterAuth';
import type { LobeChatDatabase } from '../../type';
import { getGlobalRoleIdsByName } from '../../utils/seedPlatformRoles';
import { RbacModel } from '../rbac';
import { EasyauthGrantSnapshotModel } from './easyauthGrantSnapshot';
import { PlatformJobModel } from './job';

const expandHome = (path: string) => (path.startsWith('~/') ? path.replace('~', homedir()) : path);

const readToken = (): string | null => {
  const direct = process.env.EASYAUTH_APP_TOKEN?.trim();
  if (direct) return direct;
  const file =
    process.env.EASYAUTH_APP_TOKEN_FILE?.trim() ||
    '~/.local/share/aihub/secrets/easyauth-aihub-static-token.txt';
  try {
    return readFileSync(expandHome(file), 'utf8').trim() || null;
  } catch {
    return null;
  }
};

const isAdminFlagOn = () =>
  isEnterpriseFlagTruthy(process.env.ENABLE_PLATFORM_ADMIN) ||
  isEnterpriseFlagTruthy(process.env.ENABLE_ENTERPRISE_ADMIN);

/**
 * Best-effort EasyAuth sync after session creation.
 * Never throws to the auth pipeline.
 */
export const syncEasyauthOnLogin = async (db: LobeChatDatabase, userId: string): Promise<void> => {
  if (!isAdminFlagOn()) return;

  try {
    const rbac = new RbacModel(db, userId);
    if (await rbac.isGlobalSuperAdmin(userId)) return;

    // Always enqueue a job for observability / retry (periodic worker can claim).
    try {
      const jobs = new PlatformJobModel(db);
      await jobs.enqueue({
        idempotencyKey: `easyauth-login:${userId}:${Math.floor(Date.now() / 60_000)}`,
        input: { reason: 'login', userId },
        maxAttempts: 3,
        requestedBy: userId,
        type: 'platform.easyauth.sync_user',
      });
    } catch {
      // Job table may be empty shell in some test envs.
    }

    const token = readToken();
    const baseUrl = (process.env.EASYAUTH_BASE_URL || 'https://iam.jiefakj.com').replace(/\/$/, '');
    const appKey = process.env.EASYAUTH_APP_KEY || 'aihub';
    if (!token) return;

    const accounts = await db
      .select({ accountId: account.accountId, providerId: account.providerId })
      .from(account)
      .where(eq(account.userId, userId));
    const preferred = accounts.find((r) => /authentik|oidc|sso|dingtalk/i.test(r.providerId));
    const externalUserId = preferred?.accountId ?? accounts[0]?.accountId;
    if (!externalUserId) return;

    const url = `${baseUrl}/api/v1/apps/${encodeURIComponent(appKey)}/users/${encodeURIComponent(externalUserId)}/permissions`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;

    const body = (await response.json()) as {
      catalog_version?: number;
      grant_version?: number;
      grants?: { permission?: string }[];
      groups?: { key?: string }[];
      snapshot_version?: string;
      expires_at?: string;
    };

    const grants = Array.isArray(body.grants) ? body.grants : [];
    const groups = Array.isArray(body.groups) ? body.groups : [];
    const managed = new Set<EasyauthManagedRoleName>();
    for (const g of groups) {
      if (g.key && EASYAUTH_GROUP_TO_ROLE[g.key]) managed.add(EASYAUTH_GROUP_TO_ROLE[g.key]);
    }
    for (const g of grants) {
      if (g.permission && EASYAUTH_PERMISSION_TO_ROLE[g.permission]) {
        managed.add(EASYAUTH_PERMISSION_TO_ROLE[g.permission]);
      }
    }
    const accessGranted =
      grants.some((g) => g.permission === AIHUB_ACCESS_PERMISSION) || managed.size > 0;
    if (accessGranted) managed.add(PLATFORM_SYSTEM_ROLES.PLATFORM_USER);

    const snapshots = new EasyauthGrantSnapshotModel(db);
    await snapshots.upsert({
      accessGranted,
      appKey,
      catalogVersion: Number(body.catalog_version ?? 0) || 0,
      degraded: false,
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
      externalUserId,
      grantVersion: Number(body.grant_version ?? 0) || 0,
      grants,
      groups,
      snapshotVersion: String(body.snapshot_version ?? '0'),
      userId,
    });

    const roleNames = [...managed];
    const idMap = await getGlobalRoleIdsByName(db, roleNames);
    const roleIds = roleNames.map((n) => idMap.get(n)).filter((id): id is string => Boolean(id));
    await rbac.replaceGlobalUserRoles(userId, roleIds, {
      preserveRoleNames: [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN],
    });
  } catch {
    // never block login
  }
};
