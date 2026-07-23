/**
 * Platform access status helpers.
 *
 * Global aihub.access gate was removed with EasyAuth. Authenticated users are
 * always admitted; this module still exposes resolveAccessStatus for
 * platform.getAccessStatus / admin.auth.getMyAccess compatibility shapes.
 */
import {
  type PlatformAccessStatus,
  resolvePlatformAccessStatus,
} from '@/database/models/platform/accessStatus';
import type { LobeChatDatabase } from '@/database/type';

export type AccessStatus = PlatformAccessStatus;

/**
 * Resolve whether the principal may use AIHub business APIs.
 * When platform admin feature flag is off → access always granted (upstream parity).
 * When on → any authenticated user is granted (Authentik allowlist is the gate).
 */
export const resolveAccessStatus = async (params: {
  db: LobeChatDatabase;
  userId: string;
}): Promise<AccessStatus> => {
  return resolvePlatformAccessStatus({
    db: params.db,
    userId: params.userId,
  });
};

/**
 * Always resolves successfully after EasyAuth removal (kept for call-site stability).
 */
export const assertAccessGranted = async (params: {
  db: LobeChatDatabase;
  userId: string;
}): Promise<AccessStatus> => {
  return resolveAccessStatus(params);
};
