/**
 * Platform access resolution — usable from tRPC middleware without
 * importing apps/server enterprise modules (path-boundary safe).
 *
 * Any authenticated user is admitted. Identity
 * allowlisting is owned by Authentik (DingTalk allowlist, fail-closed).
 */
import { isPlatformAdminFlagEnabled } from '@/const/platform/featureFlags';

import type { LobeChatDatabase } from '../../type';
import { RbacModel } from '../rbac';

export interface PlatformAccessStatus {
  /**
   * Always true after Authentik-only admission (allowlist gating removed).
   * Kept for response shape compatibility with existing clients/e2e.
   */
  accessGranted: boolean;
  /** Always false after Authentik-only admission; kept for response shape compatibility. */
  degraded: boolean;
  /** Always null; kept for response shape compatibility. */
  grantVersion: number | null;
  /** Always null; kept for response shape compatibility. */
  permissionRequestUrl: string | null;
  /**
   * Admission path. `not_granted` is intentionally absent — Authentik-only migration
   * never produces a denial reason from this resolver.
   */
  reason: 'granted' | 'super_admin' | 'feature_disabled';
}

// Default-on, shared with the tRPC context and the server flag parser so the three
// can never disagree about whether the platform surface is live.
const isPlatformAdminEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  isPlatformAdminFlagEnabled(env);

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
