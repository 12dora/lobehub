/**
 * aihub.access gate on authenticated lambda procedures (M02 B3).
 *
 * Flag-off: no-op (upstream parity).
 * Flag-on: requires EasyAuth access / super_admin / any global platform role.
 *
 * Allowlist: endpoints needed for the "request access" shell stay reachable.
 */
import { TRPCError } from '@trpc/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { getServerDB } from '@/database/core/db-adaptor';
import { resolvePlatformAccessStatus } from '@/database/models/platform/accessStatus';

import { trpc } from '../init';

/** Full procedure paths that must work without aihub.access. */
const ACCESS_GATE_ALLOWLIST = new Set([
  'platform.getAccessStatus',
  'platform.getCapabilities',
  'platform.getPublicSnapshot',
  'platform.getEasyauthDescriptor',
  'admin.auth.getMyAccess',
  'healthcheck',
]);

/** Leaf names (sub-router unit tests call without parent prefix). */
const ACCESS_GATE_ALLOWLIST_LEAVES = new Set([
  'getAccessStatus',
  'getCapabilities',
  'getPublicSnapshot',
  'getEasyauthDescriptor',
  'getMyAccess',
  'healthcheck',
]);

const isAccessGateAllowlisted = (path: string | undefined): boolean => {
  if (!path) return false;
  if (ACCESS_GATE_ALLOWLIST.has(path)) return true;
  const leaf = path.split('.').at(-1);
  return Boolean(leaf && ACCESS_GATE_ALLOWLIST_LEAVES.has(leaf));
};

export const enterpriseAccessGate = trpc.middleware(async (opts) => {
  const { ctx, next, path } = opts;

  if (isAccessGateAllowlisted(path)) {
    return next();
  }

  const rawUserId = ctx.userId;
  if (typeof rawUserId !== 'string' || rawUserId.length === 0) {
    // userAuth should have already rejected; keep defense-in-depth.
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  const serverDB =
    (ctx as { serverDB?: Awaited<ReturnType<typeof getServerDB>> }).serverDB ??
    (await getServerDB());

  const status = await resolvePlatformAccessStatus({
    db: serverDB,
    userId: rawUserId,
  });

  if (!status.accessGranted) {
    throw new TRPCError({
      cause: {
        data: {
          code: PLATFORM_ERROR_CODES.PLATFORM_ACCESS_NOT_GRANTED,
          details: { permissionRequestUrl: status.permissionRequestUrl },
          message: PLATFORM_ERROR_CODES.PLATFORM_ACCESS_NOT_GRANTED,
        },
      },
      code: 'FORBIDDEN',
      message: PLATFORM_ERROR_CODES.PLATFORM_ACCESS_NOT_GRANTED,
    });
  }

  return next({
    ctx: {
      accessStatus: status,
    },
  });
});
