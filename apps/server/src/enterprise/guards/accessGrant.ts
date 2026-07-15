/**
 * aihub.access gate (M02).
 * Authenticated users without EasyAuth base access (or super_admin) get
 * PLATFORM_ACCESS_NOT_GRANTED on business APIs.
 *
 * Global authedProcedure gate lives in packages/trpc enterpriseAccess middleware.
 * This module re-exports shared resolution + optional explicit middleware.
 */
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { getServerDB } from '@/database/core/db-adaptor';
import {
  type PlatformAccessStatus,
  resolvePlatformAccessStatus,
} from '@/database/models/platform/accessStatus';
import type { LobeChatDatabase } from '@/database/type';
import { trpc } from '@/libs/trpc/lambda/init';

import { parseEasyauthConfig } from '../config/easyauth';
import { throwEnterpriseError } from './enterpriseErrors';

export type AccessStatus = PlatformAccessStatus;

/**
 * Resolve whether the principal may use AIHub business APIs.
 * When platform admin feature flag is off → access always granted (upstream parity).
 */
export const resolveAccessStatus = async (params: {
  db: LobeChatDatabase;
  userId: string;
}): Promise<AccessStatus> => {
  const config = parseEasyauthConfig();
  return resolvePlatformAccessStatus({
    appKey: config.appKey,
    db: params.db,
    portalUrl: config.portalUrl,
    userId: params.userId,
  });
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
 * Explicit middleware (optional). Prefer global authedProcedure enterpriseAccessGate.
 * Resolves serverDB from ctx or getServerDB().
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

  const db =
    (ctx as { serverDB?: LobeChatDatabase }).serverDB ??
    ((await getServerDB()) as LobeChatDatabase);

  const accessStatus = await assertAccessGranted({
    db,
    userId: rawUserId,
  });
  return next({ ctx: { accessStatus } });
});
