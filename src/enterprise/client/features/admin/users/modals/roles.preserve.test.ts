/**
 * Role replace payload: protect inaccessible grants and preserve per-grant expiry.
 */
import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import {
  buildReplaceGlobalRolesPayload,
  getEligibleAssignableRoles,
  openReplaceRolesModal,
  openRevokeRoleModal,
  openRevokeSingleSessionModal,
} from './actions';

let lastBuildPayload: ((reason: string) => unknown) | null = null;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  default: { t: (k: string) => k },
}));

vi.mock('i18next', () => ({
  default: { t: (k: string) => k },
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: { colorTextSecondary: '#888', colorBorderSecondary: '#ccc' },
}));

vi.mock('@lobehub/ui', () => ({
  DatePicker: () => null,
  Text: ({ children }: { children?: unknown }) => children,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Checkbox: () => null,
  Input: () => null,
  toast: { success: vi.fn() },
}));

vi.mock('./openReasonModal', () => ({
  openReasonModal: (props: { buildPayload: (reason: string) => unknown }) => {
    lastBuildPayload = props.buildPayload;
    return { close: vi.fn(), destroy: vi.fn(), update: vi.fn() };
  },
}));

describe('buildReplaceGlobalRolesPayload per-role reconcile', () => {
  const auditorExpiry = new Date('2026-12-01T00:00:00.000Z');
  const currentWithProtectedAndTemporary = [
    { name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN, expiresAt: null },
    { name: PLATFORM_SYSTEM_ROLES.AUDITOR, expiresAt: auditorExpiry },
    { name: PLATFORM_SYSTEM_ROLES.PLATFORM_USER, expiresAt: null },
  ] as const;

  it('updating one role leaves a protected role + another role expiry intact', () => {
    // user_admin cannot assign super_admin → protected. Adding user_admin must not
    // drop super_admin or rewrite auditor's temporary grant.
    const eligible = getEligibleAssignableRoles([{ name: PLATFORM_SYSTEM_ROLES.USER_ADMIN }]);
    const payload = buildReplaceGlobalRolesPayload({
      currentRoles: currentWithProtectedAndTemporary,
      eligibleRoleNames: eligible,
      reason: 'ok',
      // Actor keeps auditor + platform_user and ADDS user_admin (the one role being updated).
      selectedRoleNames: [
        PLATFORM_SYSTEM_ROLES.AUDITOR,
        PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
        PLATFORM_SYSTEM_ROLES.USER_ADMIN,
      ],
      userId: 'u1',
    });

    expect(payload.userId).toBe('u1');
    expect(payload.expiresAt).toBeUndefined();

    // Protected super_admin always retained.
    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(payload.preserveRoleNames).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);

    // Unchanged temporary auditor stays in preserveRoleNames (server leaves expiresAt).
    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.AUDITOR);
    expect(payload.preserveRoleNames).toContain(PLATFORM_SYSTEM_ROLES.AUDITOR);

    // Unchanged platform_user preserved.
    expect(payload.preserveRoleNames).toContain(PLATFORM_SYSTEM_ROLES.PLATFORM_USER);

    // Newly added user_admin is desired but NOT preserved (fresh insert, no prior expiry).
    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.USER_ADMIN);
    expect(payload.preserveRoleNames).not.toContain(PLATFORM_SYSTEM_ROLES.USER_ADMIN);
  });

  it('retains super_admin for a non-super actor so the server does not treat it as demotion', () => {
    const eligible = getEligibleAssignableRoles([{ name: PLATFORM_SYSTEM_ROLES.USER_ADMIN }]);
    const payload = buildReplaceGlobalRolesPayload({
      currentRoles: [
        { name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN, expiresAt: null },
        { name: PLATFORM_SYSTEM_ROLES.AUDITOR, expiresAt: auditorExpiry },
      ],
      eligibleRoleNames: eligible,
      reason: 'ok',
      selectedRoleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR],
      userId: 'u1',
    });

    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.AUDITOR);
    expect(payload.preserveRoleNames).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(payload.preserveRoleNames).toContain(PLATFORM_SYSTEM_ROLES.AUDITOR);
    expect(payload.expiresAt).toBeUndefined();
  });

  it('preserves unchanged temporary grants when no shared expiry is set', () => {
    const eligible = getEligibleAssignableRoles([{ name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN }]);
    const payload = buildReplaceGlobalRolesPayload({
      currentRoles: [{ name: PLATFORM_SYSTEM_ROLES.AUDITOR, expiresAt: auditorExpiry }],
      eligibleRoleNames: eligible,
      reason: 'ok',
      selectedRoleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR],
      userId: 'u1',
    });

    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.AUDITOR);
    expect(payload.preserveRoleNames).toContain(PLATFORM_SYSTEM_ROLES.AUDITOR);
    expect(payload.expiresAt).toBeUndefined();
  });

  it('with shared expiry on a super target, strips expiresAt (server forbids pairing) but keeps super protected', () => {
    const eligible = getEligibleAssignableRoles([{ name: PLATFORM_SYSTEM_ROLES.USER_ADMIN }]);
    const shared = new Date('2027-01-15T00:00:00.000Z');
    const payload = buildReplaceGlobalRolesPayload({
      currentRoles: currentWithProtectedAndTemporary,
      eligibleRoleNames: eligible,
      reason: 'ok',
      selectedRoleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR, PLATFORM_SYSTEM_ROLES.USER_ADMIN],
      sharedExpiresAt: shared,
      userId: 'u1',
    });

    // Super is always permanent — never send expiresAt when super remains in roleNames.
    expect(payload.expiresAt).toBeUndefined();
    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    // Without a shared expiry rewrite, remaining grants stay preserved (incl. temporary auditor).
    expect(payload.preserveRoleNames).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(payload.preserveRoleNames).toContain(PLATFORM_SYSTEM_ROLES.AUDITOR);
    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.USER_ADMIN);
    expect(payload.preserveRoleNames).not.toContain(PLATFORM_SYSTEM_ROLES.USER_ADMIN);
    // Dropped platform_user is neither desired nor preserved.
    expect(payload.roleNames).not.toContain(PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
  });

  it('applies shared expiry when super is not in the desired set, rewriting only non-preserved eligible roles', () => {
    const eligible = getEligibleAssignableRoles([{ name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN }]);
    const shared = new Date('2027-01-15T00:00:00.000Z');
    const payload = buildReplaceGlobalRolesPayload({
      currentRoles: [
        { name: PLATFORM_SYSTEM_ROLES.AUDITOR, expiresAt: auditorExpiry },
        { name: PLATFORM_SYSTEM_ROLES.PLATFORM_USER, expiresAt: null },
      ],
      eligibleRoleNames: eligible,
      reason: 'ok',
      selectedRoleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR, PLATFORM_SYSTEM_ROLES.USER_ADMIN],
      sharedExpiresAt: shared,
      userId: 'u1',
    });

    expect(payload.expiresAt).toEqual(shared);
    // No protected roles → preserveRoleNames empty; eligible selected are rewritten with shared expiry.
    expect(payload.preserveRoleNames).toEqual([]);
    expect(payload.roleNames).toEqual(
      expect.arrayContaining([PLATFORM_SYSTEM_ROLES.AUDITOR, PLATFORM_SYSTEM_ROLES.USER_ADMIN]),
    );
    expect(payload.roleNames).not.toContain(PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
  });
});

describe('openReplaceRolesModal wires reconcile into buildPayload', () => {
  it('retains super_admin for a non-super actor so the server does not treat it as demotion', () => {
    openReplaceRolesModal({
      actorRoles: [{ name: PLATFORM_SYSTEM_ROLES.USER_ADMIN }],
      currentRoles: [
        { name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN, expiresAt: null },
        { name: PLATFORM_SYSTEM_ROLES.AUDITOR, expiresAt: new Date('2026-12-01T00:00:00.000Z') },
      ],
      targetLabel: 't',
      userId: 'u1',
      onConfirm: async () => undefined,
    });

    const payload = lastBuildPayload!('ok') as {
      expiresAt?: Date;
      preserveRoleNames?: string[];
      roleNames: string[];
      userId?: string;
    };

    expect(payload.userId).toBe('u1');
    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.AUDITOR);
    expect(payload.preserveRoleNames).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(payload.preserveRoleNames).toContain(PLATFORM_SYSTEM_ROLES.AUDITOR);
    expect(payload.expiresAt).toBeUndefined();
  });
});

describe('openRevokeRoleModal preserveRoleNames', () => {
  it('emits remaining roles in both roleNames and preserveRoleNames', () => {
    openRevokeRoleModal({
      remainingRoleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR, PLATFORM_SYSTEM_ROLES.PLATFORM_USER],
      revokedRoleLabel: 'User Admin',
      targetLabel: 't',
      userId: 'u1',
      onConfirm: async () => undefined,
    });

    const payload = lastBuildPayload!('ok') as {
      preserveRoleNames?: string[];
      roleNames: string[];
      userId?: string;
    };

    expect(payload.userId).toBe('u1');
    expect(payload.roleNames).toEqual([
      PLATFORM_SYSTEM_ROLES.AUDITOR,
      PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
    ]);
    expect(payload.preserveRoleNames).toEqual(payload.roleNames);
  });
});

describe('openRevokeSingleSessionModal sessionIds', () => {
  it('targets only the given session id and binds userId', () => {
    openRevokeSingleSessionModal({
      sessionId: 'sess-42',
      targetLabel: 't',
      userId: 'u1',
      onConfirm: async () => undefined,
    });

    const payload = lastBuildPayload!('ok') as { sessionIds?: string[]; userId?: string };
    expect(payload.sessionIds).toEqual(['sess-42']);
    expect(payload.userId).toBe('u1');
  });
});
