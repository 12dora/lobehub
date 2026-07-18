import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

export const deriveAdminAgentPermissions = (permissions: readonly string[]) => {
  const granted = new Set(permissions);
  return {
    canAssign: granted.has(PLATFORM_PERMISSIONS.AGENT_ASSIGN),
    canCreate: granted.has(PLATFORM_PERMISSIONS.AGENT_CREATE),
    canDelete: granted.has(PLATFORM_PERMISSIONS.AGENT_DELETE),
    canPublish: granted.has(PLATFORM_PERMISSIONS.AGENT_PUBLISH),
    canRead: granted.has(PLATFORM_PERMISSIONS.AGENT_READ),
    canUpdate: granted.has(PLATFORM_PERMISSIONS.AGENT_UPDATE),
  };
};

export const deriveAdminAgentActionAvailability = (params: {
  dirty: boolean;
  hasCurrentVersion: boolean;
  permissions: ReturnType<typeof deriveAdminAgentPermissions>;
}) => ({
  canArchiveNow: params.permissions.canDelete && !params.dirty,
  canAssign: params.permissions.canAssign,
  canPublishNow: params.permissions.canPublish && params.hasCurrentVersion && !params.dirty,
  canRollbackNow: params.permissions.canPublish && !params.dirty,
  canSaveVersion: params.permissions.canUpdate,
});
