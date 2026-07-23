/**
 * Platform access resolution — usable from tRPC middleware without
 * importing apps/server enterprise modules (path-boundary safe).
 *
 * Any authenticated user is admitted. Identity
 * allowlisting is owned by Authentik (DingTalk allowlist, fail-closed).
 */
import { isEnterpriseFlagTruthy } from '@/const/platform/featureFlags';

import type { LobeChatDatabase } from '../../type';
import { RbacModel } from '../rbac';

export interface PlatformAccessStatus {
  accessGranted: boolean;
  degraded: boolean;
  grantVersion: number | null;
  /** Always null; kept for response shape compatibility. */
  permissionRequestUrl: string | null;
  reason: 'granted' | 'super_admin' | 'not_granted' | 'feature_disabled';
}

const isPlatformAdminEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  isEnterpriseFlagTruthy(env.ENABLE_PLATFORM_ADMIN) ||
  isEnterpriseFlagTruthy(env.ENABLE_ENTERPRISE_ADMIN);

export const resolvePlatformAccessStatus = async (params: {
  db: LobeChatDatabase;
  env?: NodeJS.ProcessEnv;
  userId: string;
}): Promise<PlatformAccessStatus> => {
  const env = params.env ?? process.env;
  if (!isPlatformAdminEnabled(env)) {
    return {
      accessGranted: true,
      degraded: false,
      grantVersion: null,
      permissionRequestUrl: null,
      reason: 'feature_disabled',
    };
  }

  const rbac = new RbacModel(params.db, params.userId);
  if (await rbac.isGlobalSuperAdmin(params.userId)) {
    return {
      accessGranted: true,
      degraded: false,
      grantVersion: null,
      permissionRequestUrl: null,
      reason: 'super_admin',
    };
  }

  // Authentik-only admission: any authenticated principal is granted.
  return {
    accessGranted: true,
    degraded: false,
    grantVersion: null,
    permissionRequestUrl: null,
    reason: 'granted',
  };
};
