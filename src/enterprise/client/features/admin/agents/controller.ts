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

/**
 * Which detail/list actions an operator may start. There is no draft any more, so nothing is
 * gated on a dirty editor: creating and saving both publish in one server transaction, which is
 * why they need the write permission AND publish (the server enforces the same compound).
 */
export const deriveAdminAgentActionAvailability = (params: {
  hasCurrentVersion?: boolean;
  permissions: ReturnType<typeof deriveAdminAgentPermissions>;
}) => ({
  canArchiveNow: params.permissions.canDelete,
  canAssign: params.permissions.canAssign,
  canCreate: params.permissions.canCreate && params.permissions.canPublish,
  canEdit: params.permissions.canUpdate && params.permissions.canPublish,
  // Initializing the default assistant also points every member at it, so the server demands
  // AGENT_ASSIGN on top of the create+publish compound. Reusing `canCreate` here would let an
  // operator without it start a write that can only come back as an error.
  canProvisionDefaultInbox:
    params.permissions.canCreate && params.permissions.canPublish && params.permissions.canAssign,
  canSetDefaultNow: params.permissions.canPublish && Boolean(params.hasCurrentVersion),
});
