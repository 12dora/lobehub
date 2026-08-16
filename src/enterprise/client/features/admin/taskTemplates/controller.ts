import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

/**
 * 任务模板 reuses the platform-agent permission codes on purpose — see the comment on
 * `adminTaskTemplatesRouter`. Keeping the client derivation in one place means the table
 * actions and the server gates cannot drift.
 */
export const deriveTaskTemplatePermissions = (permissions: readonly string[]) => {
  const granted = new Set(permissions);
  return {
    canCreate: granted.has(PLATFORM_PERMISSIONS.AGENT_CREATE),
    canDelete: granted.has(PLATFORM_PERMISSIONS.AGENT_DELETE),
    canRead: granted.has(PLATFORM_PERMISSIONS.AGENT_READ),
    canUpdate: granted.has(PLATFORM_PERMISSIONS.AGENT_UPDATE),
  };
};
