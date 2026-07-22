import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from './permissions';
import {
  EASYAUTH_GROUP_TO_ROLE,
  EASYAUTH_MANAGED_ROLES,
  PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_SYSTEM_ROLES,
} from './roles';

describe('platform system roles', () => {
  it('never puts super_admin in EasyAuth managed set', () => {
    expect(EASYAUTH_MANAGED_ROLES).not.toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(EASYAUTH_GROUP_TO_ROLE).not.toHaveProperty('super_admin');
  });

  it('super_admin has every platform permission', () => {
    const codes = new Set(PLATFORM_ROLE_PERMISSIONS[PLATFORM_SYSTEM_ROLES.SUPER_ADMIN]);
    for (const code of Object.values(PLATFORM_PERMISSIONS)) {
      expect(codes.has(code)).toBe(true);
    }
  });

  it('user_admin can manage users but not AI providers', () => {
    const codes = PLATFORM_ROLE_PERMISSIONS[PLATFORM_SYSTEM_ROLES.USER_ADMIN];
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
    expect(codes).toContain(PLATFORM_PERMISSIONS.USER_READ);
    expect(codes).toContain(PLATFORM_PERMISSIONS.POLICY_READ);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.POLICY_UPDATE);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.USER_BAN);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.USER_DELETE);
    expect(codes).not.toContain(PLATFORM_PERMISSIONS.AI_PROVIDER_DELETE);
  });

  it('platform_user has no admin permissions', () => {
    expect(PLATFORM_ROLE_PERMISSIONS[PLATFORM_SYSTEM_ROLES.PLATFORM_USER]).toEqual([]);
  });
});
