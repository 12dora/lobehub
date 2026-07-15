/**
 * aihub.access gate (M02).
 * Authenticated users without EasyAuth base access (or super_admin) get
 * PLATFORM_ACCESS_NOT_GRANTED on business APIs.
 */
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { EasyauthGrantSnapshotModel } from '@/database/models/platform/easyauthGrantSnapshot';
import { RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase } from '@/database/type';
import { trpc } from '@/libs/trpc/lambda/init';

import { parseEasyauthConfig } from '../config/easyauth';
import { isPlatformAdminFeatureEnabled } from '../featureFlags';
import { throwEnterpriseError } from './enterpriseErrors';

export interface AccessStatus {
  accessGranted: boolean;
  degraded: boolean;
  grantVersion: number | null;
  permissionRequestUrl: string | null;
  reason: 'granted' | 'super_admin' | 'not_granted' | 'feature_disabled';
}

/**
 * Resolve whether the principal may use AIHub business APIs.
 * When platform admin feature flag is off → access always granted (upstream parity).
 */
export const resolveAccessStatus = async (params: {
  db: LobeChatDatabase;
  userId: string;
}): Promise<AccessStatus> => {
  if (!isPlatformAdminFeatureEnabled()) {
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

  const config = parseEasyauthConfig();
  const snapshots = new EasyauthGrantSnapshotModel(params.db);
  const snap = await snapshots.findByUser(params.userId, config.appKey);

  // Also treat any global platform role (except empty) as access
  const globalRoles = await rbac.getGlobalUserRoles(params.userId);
  const hasPlatformRole = globalRoles.length > 0;

  const accessGranted = Boolean(snap?.accessGranted) || hasPlatformRole;
  const permissionRequestUrl = accessGranted
    ? null
    : `${config.portalUrl}/apps/${config.appKey}/request`;

  return {
    accessGranted,
    degraded: Boolean(snap?.degraded),
    grantVersion: snap?.grantVersion ?? null,
    permissionRequestUrl,
    reason: accessGranted ? 'granted' : 'not_granted',
  };
};

export const assertAccessGranted = async (params: {
  db: LobeChatDatabase;
  userId: string;
}): Promise<AccessStatus> => {
  const status = await resolveAccessStatus(params);
  if (!status.accessGranted) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_ACCESS_NOT_GRANTED,
      details: {
        permissionRequestUrl: status.permissionRequestUrl,
      },
      httpCode: 'FORBIDDEN',
      message: PLATFORM_ERROR_CODES.PLATFORM_ACCESS_NOT_GRANTED,
    });
  }
  return status;
};

/**
 * tRPC middleware requiring aihub.access (or super_admin / flag-off).
 * Compose after serverDatabase + authedProcedure.
 */
export const withAccessGranted = trpc.middleware(async ({ ctx, next }) => {
  const rawUserId = ctx.userId;
  if (typeof rawUserId !== 'string' || rawUserId.length === 0) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_ACCESS_NOT_GRANTED,
      httpCode: 'UNAUTHORIZED',
      message: 'UNAUTHORIZED',
    });
  }

  const db = (ctx as { serverDB?: LobeChatDatabase }).serverDB;
  if (!db) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      message: 'serverDB missing',
    });
  }

  const accessStatus = await assertAccessGranted({
    db,
    userId: rawUserId,
  });
  return next({ ctx: { accessStatus } });
});
