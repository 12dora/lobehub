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

/**
 * One named predicate per gate, so the rule behind each button is readable on its own.
 *
 * `allowHighRisk` is false while the detail data is stale: every *write* is withheld,
 * but the two read-only facts stay as they are — `canReadAudit` (a log is safe to show)
 * and `canManageCredentials` (the button stays visible and OverviewTab disables it from
 * the missing handler, so the operator is told why instead of losing the control).
 */
const resolveGates = (input: UserDetailActionFlagsInput) => {
  const { allowHighRisk } = input;

  return {
    /** Ban and unban share one gate — they are the two sides of the same permission. */
    mayBanOrUnban: input.canBan && allowHighRisk,
    /** Hard delete of the user and everything they own. */
    mayDelete: input.canDelete && allowHighRisk,
    /** Set password and disable 2FA — gated by the credential permission. */
    mayManageCredentials: input.canManageCredentials && allowHighRisk,
    /** Replace permissions and revoke a single role. */
    mayManageRoles: input.canManageRoles && allowHighRisk,
    /** Revoke all sessions and revoke one session. */
    mayRevokeSessions: input.canRevoke && allowHighRisk,
  };
};

/** Hand the opener over only when its gate is open; `undefined` is what hides the control. */
const openerWhen = <T>(allowed: boolean, opener: T): T | undefined =>
  allowed ? opener : undefined;

export function resolveUserDetailActionFlags(
  input: UserDetailActionFlagsInput,
): UserDetailActionFlags {
  const { canManageCredentials, canReadAudit, openers } = input;
  const { mayBanOrUnban, mayDelete, mayManageCredentials, mayManageRoles, mayRevokeSessions } =
    resolveGates(input);

  return {
    access: {
      canManageRoles: mayManageRoles,
      onRevokeRole: openerWhen(mayManageRoles, openers.openRevokeRole),
      onUpdatePermissions: openerWhen(mayManageRoles, openers.openUpdatePermissions),
    },
    audit: {
      canReadAudit,
    },
    overview: {
      canBan: mayBanOrUnban,
      canDelete: mayDelete,
      canManageCredentials,
      onBan: openerWhen(mayBanOrUnban, openers.openBan),
      onDelete: openerWhen(mayDelete, openers.openDelete),
      onDisableTwoFactor: openerWhen(mayManageCredentials, openers.openDisableTwoFactor),
      onSetPassword: openerWhen(mayManageCredentials, openers.openSetPassword),
      onUnban: openerWhen(mayBanOrUnban, openers.openUnban),
    },
    sessions: {
      canRevoke: mayRevokeSessions,
      onRevokeAll: openerWhen(mayRevokeSessions, openers.openRevokeAll),
      onRevokeSession: openerWhen(mayRevokeSessions, openers.openRevokeSingle),
    },
  };
}
