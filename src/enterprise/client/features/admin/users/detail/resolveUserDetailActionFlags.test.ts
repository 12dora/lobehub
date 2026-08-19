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
