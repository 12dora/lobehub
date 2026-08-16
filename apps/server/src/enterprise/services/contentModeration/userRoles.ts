import { RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase } from '@/database/type';

import { MODERATION_USER_ROLE_MEMO_TTL_MS } from './constants';

const memo = new Map<string, { expiresAt: number; roles: string[] }>();

/**
 * Platform (global) role names for a user, memoized 30s in-process.
 * Reuses {@link RbacModel.getGlobalUserRoles} — the same read `platformRbac` /
 * `withPlatformPermission` use.
 */
export const getUserPlatformRoleNames = async (
  db: LobeChatDatabase,
  userId: string,
  now: () => number = Date.now,
): Promise<string[]> => {
  const at = now();
  const cached = memo.get(userId);
  if (cached && cached.expiresAt > at) return cached.roles;

  const rbac = new RbacModel(db, 'system');
  const rows = await rbac.getGlobalUserRoles(userId);
  const roles = rows.map((row) => row.name);
  memo.set(userId, { expiresAt: at + MODERATION_USER_ROLE_MEMO_TTL_MS, roles });
  return roles;
};

export const resetUserPlatformRoleMemo = () => {
  memo.clear();
};
