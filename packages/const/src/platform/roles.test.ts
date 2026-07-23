import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from './permissions';
import { PLATFORM_ROLE_PERMISSIONS, PLATFORM_SYSTEM_ROLES } from './roles';

describe('platform system roles', () => {
  it('defines the expected system role set', () => {
    expect(Object.values(PLATFORM_SYSTEM_ROLES)).toEqual(
      expect.arrayContaining([
        PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
        PLATFORM_SYSTEM_ROLES.USER_ADMIN,
        PLATFORM_SYSTEM_ROLES.AI_ADMIN,
        PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
        PLATFORM_SYSTEM_ROLES.AUDITOR,
        PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
      ]),
    );
  });

  it('super_admin has every platform permission', () => {
    const codes = new Set(PLATFORM_ROLE_PERMISSIONS[PLATFORM_SYSTEM_ROLES.SUPER_ADMIN]);
    for (const code of Object.values(PLATFORM_PERMISSIONS)) {
      expect(codes.has(code)).toBe(true);
    }
  });

  it('user_admin can manage users but not AI providers', () => {
    const codes = PLATFORM_ROLE_PERMISSIONS[PLATFORM_SYSTEM_ROLES.USER_ADMIN];
    expect(codes).toContain(PLATFORM_PERMISSIONS.USER_CREATE);
    expect(codes).toContain(PLATFORM_PERMISSIONS.USER_BAN);
    expect(codes).toContain(PLATFORM_PERMISSIONS.USER_DELETE);
    expect(codes).toContain(PLATFORM_PERMISSIONS.USER_ROLE_MANAGE);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE);
  });

  it('ai_admin manages resource policy but cannot ban users', () => {
    const codes = PLATFORM_ROLE_PERMISSIONS[PLATFORM_SYSTEM_ROLES.AI_ADMIN];
    expect(codes).toContain(PLATFORM_PERMISSIONS.AI_MODEL_PUBLISH);
    expect(codes).toContain(PLATFORM_PERMISSIONS.POLICY_READ);
    expect(codes).toContain(PLATFORM_PERMISSIONS.POLICY_UPDATE);
    expect(codes).toContain(PLATFORM_PERMISSIONS.POLICY_PUBLISH);
    expect(codes).toContain(PLATFORM_PERMISSIONS.CRED_READ);
    expect(codes).toContain(PLATFORM_PERMISSIONS.CRED_CREATE);
    expect(codes).toContain(PLATFORM_PERMISSIONS.CRED_UPDATE);
    expect(codes).toContain(PLATFORM_PERMISSIONS.CRED_DELETE);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.USER_BAN);
  });

  it('auditor is read-only on mutating user/AI actions', () => {
    const codes = PLATFORM_ROLE_PERMISSIONS[PLATFORM_SYSTEM_ROLES.AUDITOR];
    expect(codes).toContain(PLATFORM_PERMISSIONS.AUDIT_EXPORT);
    expect(codes).toContain(PLATFORM_PERMISSIONS.AUDIT_READ);
    expect(codes).toContain(PLATFORM_PERMISSIONS.USER_READ);
    expect(codes).toContain(PLATFORM_PERMISSIONS.POLICY_READ);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.POLICY_UPDATE);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.USER_BAN);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.USER_CREATE);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.USER_DELETE);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.AI_PROVIDER_DELETE);
    // Conversation body evidence and governance mutations are not default auditor grants.
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.AUDIT_POLICY_UPDATE);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE);
  });

  it('platform_user has no admin permissions', () => {
    expect(PLATFORM_ROLE_PERMISSIONS[PLATFORM_SYSTEM_ROLES.PLATFORM_USER]).toEqual([]);
  });
});
