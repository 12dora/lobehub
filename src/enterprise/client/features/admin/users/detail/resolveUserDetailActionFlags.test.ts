import { describe, expect, it } from 'vitest';

import type { UserDetailActionOpeners } from './resolveUserDetailActionFlags';
import { resolveUserDetailActionFlags } from './resolveUserDetailActionFlags';

const openers: UserDetailActionOpeners = {
  openBan: () => undefined,
  openDelete: () => undefined,
  openDisableTwoFactor: () => undefined,
  openRevokeAll: () => undefined,
  openRevokeRole: () => undefined,
  openRevokeSingle: () => undefined,
  openSetPassword: () => undefined,
  openUnban: () => undefined,
  openUpdatePermissions: () => undefined,
};

const allPermissions = {
  canBan: true,
  canDelete: true,
  canManageCredentials: true,
  canManageRoles: true,
  canReadAudit: true,
  canRevoke: true,
};

const noPermissions = {
  canBan: false,
  canDelete: false,
  canManageCredentials: false,
  canManageRoles: false,
  canReadAudit: false,
  canRevoke: false,
};

const writeHandlers = (result: ReturnType<typeof resolveUserDetailActionFlags>) => [
  result.overview.onBan,
  result.overview.onDelete,
  result.overview.onSetPassword,
  result.overview.onUnban,
  result.overview.onDisableTwoFactor,
  result.access.onRevokeRole,
  result.access.onUpdatePermissions,
  result.sessions.onRevokeAll,
  result.sessions.onRevokeSession,
];

describe('resolveUserDetailActionFlags', () => {
  it('when stale, hides high-risk write chrome but keeps credentials visible and audit ungated', () => {
    const result = resolveUserDetailActionFlags({
      ...allPermissions,
      allowHighRisk: false,
      openers,
    });

    expect(result.overview.canBan).toBe(false);
    expect(result.overview.canDelete).toBe(false);
    expect(result.overview.onBan).toBeUndefined();
    expect(result.overview.onDelete).toBeUndefined();
    expect(result.overview.onUnban).toBeUndefined();
    expect(result.access.canManageRoles).toBe(false);
    expect(result.access.onRevokeRole).toBeUndefined();
    expect(result.access.onUpdatePermissions).toBeUndefined();
    expect(result.sessions.canRevoke).toBe(false);
    expect(result.sessions.onRevokeAll).toBeUndefined();
    expect(result.sessions.onRevokeSession).toBeUndefined();

    // Credential permission is NOT AND-ed with allowHighRisk — button stays visible.
    expect(result.overview.canManageCredentials).toBe(true);
    // Handlers still drop so OverviewTab disables via Boolean(onSetPassword).
    expect(result.overview.onSetPassword).toBeUndefined();
    expect(result.overview.onDisableTwoFactor).toBeUndefined();

    // Audit is read-only; stale must not blank the log.
    expect(result.audit.canReadAudit).toBe(true);
  });

  it('when live with only canBan, only ban/unban handlers are present', () => {
    const result = resolveUserDetailActionFlags({
      ...noPermissions,
      allowHighRisk: true,
      canBan: true,
      openers,
    });

    expect(result.overview.canBan).toBe(true);
    expect(result.overview.onBan).toBe(openers.openBan);
    expect(result.overview.onUnban).toBe(openers.openUnban);

    expect(result.overview.canDelete).toBe(false);
    expect(result.overview.canManageCredentials).toBe(false);
    expect(result.overview.onDelete).toBeUndefined();
    expect(result.overview.onSetPassword).toBeUndefined();
    expect(result.overview.onDisableTwoFactor).toBeUndefined();
    expect(result.access.canManageRoles).toBe(false);
    expect(result.access.onRevokeRole).toBeUndefined();
    expect(result.access.onUpdatePermissions).toBeUndefined();
    expect(result.sessions.canRevoke).toBe(false);
    expect(result.sessions.onRevokeAll).toBeUndefined();
    expect(result.sessions.onRevokeSession).toBeUndefined();
    expect(result.audit.canReadAudit).toBe(false);
  });

  it('when live with only canManageCredentials, only password + disable-2FA handlers are present', () => {
    const result = resolveUserDetailActionFlags({
      ...noPermissions,
      allowHighRisk: true,
      canManageCredentials: true,
      openers,
    });

    expect(result.overview.canManageCredentials).toBe(true);
    expect(result.overview.onSetPassword).toBe(openers.openSetPassword);
    expect(result.overview.onDisableTwoFactor).toBe(openers.openDisableTwoFactor);

    expect(result.overview.canBan).toBe(false);
    expect(result.overview.canDelete).toBe(false);
    expect(result.overview.onBan).toBeUndefined();
    expect(result.overview.onDelete).toBeUndefined();
    expect(result.overview.onUnban).toBeUndefined();
    expect(result.access.canManageRoles).toBe(false);
    expect(result.access.onRevokeRole).toBeUndefined();
    expect(result.access.onUpdatePermissions).toBeUndefined();
    expect(result.sessions.canRevoke).toBe(false);
    expect(result.sessions.onRevokeAll).toBeUndefined();
    expect(result.sessions.onRevokeSession).toBeUndefined();
    expect(result.audit.canReadAudit).toBe(false);
  });

  it('when live with only canReadAudit, audit is true and every write handler is undefined', () => {
    const result = resolveUserDetailActionFlags({
      ...noPermissions,
      allowHighRisk: true,
      canReadAudit: true,
      openers,
    });

    expect(result.audit.canReadAudit).toBe(true);
    expect(result.overview.canBan).toBe(false);
    expect(result.overview.canDelete).toBe(false);
    expect(result.overview.canManageCredentials).toBe(false);
    expect(result.access.canManageRoles).toBe(false);
    expect(result.sessions.canRevoke).toBe(false);
    expect(writeHandlers(result).every((handler) => handler === undefined)).toBe(true);
  });
});

/**
 * Literal truth tables — one row per (allowHighRisk × permission) pair.
 *
 * This is a permission surface: the values below are written out by hand rather than
 * derived, so a refactor that "simplifies" a gate has to move a visible cell to pass.
 */
type TruthRow = { allowHighRisk: boolean; expected: boolean; granted: boolean };

/** Withheld while the detail data is stale. */
const gated: TruthRow[] = [
  { allowHighRisk: false, expected: false, granted: false },
  { allowHighRisk: false, expected: false, granted: true },
  { allowHighRisk: true, expected: false, granted: false },
  { allowHighRisk: true, expected: true, granted: true },
];

/** Read-only fact: staleness does not touch it. */
const ungated: TruthRow[] = [
  { allowHighRisk: false, expected: false, granted: false },
  { allowHighRisk: false, expected: true, granted: true },
  { allowHighRisk: true, expected: false, granted: false },
  { allowHighRisk: true, expected: true, granted: true },
];

type PermissionKey = keyof typeof allPermissions;
type Flags = ReturnType<typeof resolveUserDetailActionFlags>;

const resolveWith = (
  permission: PermissionKey,
  granted: boolean,
  allowHighRisk: boolean,
  base = noPermissions,
): Flags =>
  resolveUserDetailActionFlags({
    ...base,
    [permission]: granted,
    allowHighRisk,
    openers,
  });

const booleanFlagCases: {
  flag: string;
  permission: PermissionKey;
  read: (result: Flags) => boolean;
  table: TruthRow[];
}[] = [
  {
    flag: 'access.canManageRoles',
    permission: 'canManageRoles',
    read: (r) => r.access.canManageRoles,
    table: gated,
  },
  {
    flag: 'audit.canReadAudit',
    permission: 'canReadAudit',
    read: (r) => r.audit.canReadAudit,
    table: ungated,
  },
  { flag: 'overview.canBan', permission: 'canBan', read: (r) => r.overview.canBan, table: gated },
  {
    flag: 'overview.canDelete',
    permission: 'canDelete',
    read: (r) => r.overview.canDelete,
    table: gated,
  },
  {
    flag: 'overview.canManageCredentials',
    permission: 'canManageCredentials',
    read: (r) => r.overview.canManageCredentials,
    table: ungated,
  },
  {
    flag: 'sessions.canRevoke',
    permission: 'canRevoke',
    read: (r) => r.sessions.canRevoke,
    table: gated,
  },
];

/** Every handler is gated: present only when its permission is held AND data is live. */
const handlerCases: {
  flag: string;
  opener: UserDetailActionOpeners[keyof UserDetailActionOpeners];
  permission: PermissionKey;
  read: (result: Flags) => unknown;
}[] = [
  {
    flag: 'access.onRevokeRole',
    opener: openers.openRevokeRole,
    permission: 'canManageRoles',
    read: (r) => r.access.onRevokeRole,
  },
  {
    flag: 'access.onUpdatePermissions',
    opener: openers.openUpdatePermissions,
    permission: 'canManageRoles',
    read: (r) => r.access.onUpdatePermissions,
  },
  {
    flag: 'overview.onBan',
    opener: openers.openBan,
    permission: 'canBan',
    read: (r) => r.overview.onBan,
  },
  {
    flag: 'overview.onUnban',
    opener: openers.openUnban,
    permission: 'canBan',
    read: (r) => r.overview.onUnban,
  },
  {
    flag: 'overview.onDelete',
    opener: openers.openDelete,
    permission: 'canDelete',
    read: (r) => r.overview.onDelete,
  },
  {
    flag: 'overview.onSetPassword',
    opener: openers.openSetPassword,
    permission: 'canManageCredentials',
    read: (r) => r.overview.onSetPassword,
  },
  {
    flag: 'overview.onDisableTwoFactor',
    opener: openers.openDisableTwoFactor,
    permission: 'canManageCredentials',
    read: (r) => r.overview.onDisableTwoFactor,
  },
  {
    flag: 'sessions.onRevokeAll',
    opener: openers.openRevokeAll,
    permission: 'canRevoke',
    read: (r) => r.sessions.onRevokeAll,
  },
  {
    flag: 'sessions.onRevokeSession',
    opener: openers.openRevokeSingle,
    permission: 'canRevoke',
    read: (r) => r.sessions.onRevokeSession,
  },
];

describe('resolveUserDetailActionFlags truth table', () => {
  describe.each(booleanFlagCases)('$flag', ({ permission, read, table }) => {
    it.each(table)(
      'is $expected when granted=$granted and allowHighRisk=$allowHighRisk',
      ({ allowHighRisk, expected, granted }) => {
        expect(read(resolveWith(permission, granted, allowHighRisk))).toBe(expected);
      },
    );
  });

  describe.each(handlerCases)('$flag', ({ opener, permission, read }) => {
    it.each(gated)(
      'is $expected when granted=$granted and allowHighRisk=$allowHighRisk',
      ({ allowHighRisk, expected, granted }) => {
        const value = read(resolveWith(permission, granted, allowHighRisk));
        if (expected) expect(value).toBe(opener);
        else expect(value).toBeUndefined();
      },
    );
  });

  it.each(booleanFlagCases)(
    '$flag stays off when every OTHER permission is granted',
    ({ permission, read }) => {
      expect(read(resolveWith(permission, false, true, allPermissions))).toBe(false);
    },
  );

  it.each(handlerCases)(
    '$flag stays undefined when every OTHER permission is granted',
    ({ permission, read }) => {
      expect(read(resolveWith(permission, false, true, allPermissions))).toBeUndefined();
    },
  );
});
