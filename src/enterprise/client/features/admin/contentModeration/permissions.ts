import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

export interface ModerationPermissions {
  /** Ban / unban shortcuts inside the record drawer reuse 用户管理's permission. */
  canBanUsers: boolean;
  /** Save settings, delete records, reveal prompts, clear the decision cache. */
  canManage: boolean;
  /** Enter the page at all. */
  canRead: boolean;
}

/** Single place the three moderation surfaces derive their gates from. */
export const deriveModerationPermissions = (granted: readonly string[]): ModerationPermissions => {
  const set = new Set(granted);
  return {
    canBanUsers: set.has(PLATFORM_PERMISSIONS.USER_BAN),
    canManage: set.has(PLATFORM_PERMISSIONS.MODERATION_MANAGE),
    canRead: set.has(PLATFORM_PERMISSIONS.MODERATION_READ),
  };
};
