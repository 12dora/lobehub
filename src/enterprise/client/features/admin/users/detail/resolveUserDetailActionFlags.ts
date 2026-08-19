export interface UserDetailActionOpeners {
  openBan: () => void;
  openDelete: () => void;
  openDisableTwoFactor: () => void;
  openRevokeAll: () => void;
  openRevokeRole: (roleName: string) => void;
  openRevokeSingle: (sessionId: string) => void;
  openSetPassword: () => void;
  openUnban: () => void;
  openUpdatePermissions: () => void;
}

export interface UserDetailActionFlagsInput {
  allowHighRisk: boolean;
  canBan: boolean;
  canDelete: boolean;
  canManageCredentials: boolean;
  canManageRoles: boolean;
  canReadAudit: boolean;
  canRevoke: boolean;
  openers: UserDetailActionOpeners;
}

export interface UserDetailActionFlags {
  access: {
    canManageRoles: boolean;
    onRevokeRole?: UserDetailActionOpeners['openRevokeRole'];
    onUpdatePermissions?: UserDetailActionOpeners['openUpdatePermissions'];
  };
  audit: {
    canReadAudit: boolean;
  };
  overview: {
    canBan: boolean;
    canDelete: boolean;
    canManageCredentials: boolean;
    onBan?: UserDetailActionOpeners['openBan'];
    onDelete?: UserDetailActionOpeners['openDelete'];
    onDisableTwoFactor?: UserDetailActionOpeners['openDisableTwoFactor'];
    onSetPassword?: UserDetailActionOpeners['openSetPassword'];
    onUnban?: UserDetailActionOpeners['openUnban'];
  };
  sessions: {
    canRevoke: boolean;
    onRevokeAll?: UserDetailActionOpeners['openRevokeAll'];
    onRevokeSession?: UserDetailActionOpeners['openRevokeSingle'];
  };
}

export function resolveUserDetailActionFlags(
  input: UserDetailActionFlagsInput,
): UserDetailActionFlags {
  const {
    allowHighRisk,
    canBan,
    canDelete,
    canManageCredentials,
    canManageRoles,
    canReadAudit,
    canRevoke,
    openers,
  } = input;

  return {
    access: {
      canManageRoles: canManageRoles && allowHighRisk,
      onRevokeRole: canManageRoles && allowHighRisk ? openers.openRevokeRole : undefined,
      onUpdatePermissions:
        canManageRoles && allowHighRisk ? openers.openUpdatePermissions : undefined,
    },
    audit: {
      canReadAudit,
    },
    overview: {
      canBan: canBan && allowHighRisk,
      canDelete: canDelete && allowHighRisk,
      canManageCredentials,
      onBan: canBan && allowHighRisk ? openers.openBan : undefined,
      onDelete: canDelete && allowHighRisk ? openers.openDelete : undefined,
      onDisableTwoFactor:
        canManageCredentials && allowHighRisk ? openers.openDisableTwoFactor : undefined,
      onSetPassword: canManageCredentials && allowHighRisk ? openers.openSetPassword : undefined,
      onUnban: canBan && allowHighRisk ? openers.openUnban : undefined,
    },
    sessions: {
      canRevoke: canRevoke && allowHighRisk,
      onRevokeAll: canRevoke && allowHighRisk ? openers.openRevokeAll : undefined,
      onRevokeSession: canRevoke && allowHighRisk ? openers.openRevokeSingle : undefined,
    },
  };
}
