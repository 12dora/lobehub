/**
 * Platform access (aihub.access) resolution — usable from tRPC middleware without
 * importing apps/server enterprise modules (path-boundary safe).
 */
import { isEnterpriseFlagTruthy } from '@/const/platform/featureFlags';

import type { LobeChatDatabase } from '../../type';
import { RbacModel } from '../rbac';
import { EasyauthGrantSnapshotModel } from './easyauthGrantSnapshot';

export interface PlatformAccessStatus {
  accessGranted: boolean;
  degraded: boolean;
  grantVersion: number | null;
  permissionRequestUrl: string | null;
  reason: 'granted' | 'super_admin' | 'not_granted' | 'feature_disabled';
}

const isPlatformAdminEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  isEnterpriseFlagTruthy(env.ENABLE_PLATFORM_ADMIN) ||
  isEnterpriseFlagTruthy(env.ENABLE_ENTERPRISE_ADMIN);

export const resolvePlatformAccessStatus = async (params: {
  appKey?: string;
  db: LobeChatDatabase;
  env?: NodeJS.ProcessEnv;
  portalUrl?: string;
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

  const appKey = params.appKey ?? env.EASYAUTH_APP_KEY ?? 'aihub';
  const portalBase = (
    params.portalUrl ??
    env.EASYAUTH_PORTAL_URL ??
    env.EASYAUTH_BASE_URL ??
    'https://iam.jiefakj.com'
  ).replace(/\/$/, '');

  const snapshots = new EasyauthGrantSnapshotModel(params.db);
  const snap = await snapshots.findByUser(params.userId, appKey);
  const globalRoles = await rbac.getGlobalUserRoles(params.userId);
  const accessGranted = Boolean(snap?.accessGranted) || globalRoles.length > 0;

  return {
    accessGranted,
    degraded: Boolean(snap?.degraded),
    grantVersion: snap?.grantVersion ?? null,
    permissionRequestUrl: accessGranted ? null : `${portalBase}/apps/${appKey}/request`,
    reason: accessGranted ? 'granted' : 'not_granted',
  };
};
