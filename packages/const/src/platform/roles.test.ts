import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from './permissions';
import {
  isPlatformSystemRoleName,
  PLATFORM_ROLE_DESCRIPTIONS,
  PLATFORM_ROLE_DISPLAY_NAMES,
  PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_SYSTEM_ROLES,
  resolvePlatformRoleDescription,
  resolvePlatformRoleLabel,
} from './roles';

describe('platform system roles', () => {
  it('defines the exact system role catalog', () => {
    expect(Object.values(PLATFORM_SYSTEM_ROLES)).toEqual([
      PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
      PLATFORM_SYSTEM_ROLES.USER_ADMIN,
      PLATFORM_SYSTEM_ROLES.AI_ADMIN,
      PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
      PLATFORM_SYSTEM_ROLES.AUDITOR,
      PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
    ]);
  });

  it('identifies system role names for i18n-first display', () => {
    expect(isPlatformSystemRoleName(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN)).toBe(true);
    expect(isPlatformSystemRoleName('custom_role')).toBe(false);
  });

  it('persists locale-neutral seed metadata (never English UI copy)', () => {
    for (const name of Object.values(PLATFORM_SYSTEM_ROLES)) {
      expect(PLATFORM_ROLE_DISPLAY_NAMES[name]).toBe(name);
      expect(PLATFORM_ROLE_DESCRIPTIONS[name]).toBe(name);
      // Guard against reintroducing English prose that would override zh-CN.
      expect(PLATFORM_ROLE_DISPLAY_NAMES[name]).not.toMatch(/[A-Z][a-z]+ [A-Z]/);
    }
  });

  it('zh-CN system role labels ignore stored English displayName', () => {
    const zh = {
      'users.roles.desc.super_admin': '本地应急超级管理员',
      'users.roles.super_admin': '超级管理员',
    };
    const t = (key: string, options?: { defaultValue?: string }) =>
      (zh as Record<string, string>)[key] ?? options?.defaultValue ?? key;

    // Even if DB still has historical English seed text, i18n must win.
    expect(
      resolvePlatformRoleLabel(
        { displayName: 'Super Admin', name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN },
        t,
      ),
    ).toBe('超级管理员');
    expect(
      resolvePlatformRoleDescription(
        { displayName: 'Super Admin', name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN },
        t,
      ),
    ).toBe('本地应急超级管理员');

    // Custom roles still use stored displayName.
    expect(resolvePlatformRoleLabel({ displayName: 'Ops Lead', name: 'ops_lead' }, t)).toBe(
      'Ops Lead',
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
