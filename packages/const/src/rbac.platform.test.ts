import { describe, expect, it } from 'vitest';

import { getAllowedScopesForAction, isPlatformPermissionCode, SYSTEM_DEFAULT_ROLES } from './rbac';

describe('rbac platform scope rules (M02)', () => {
  it('exposes platform system role names on SYSTEM_DEFAULT_ROLES', () => {
    expect(SYSTEM_DEFAULT_ROLES.SUPER_ADMIN).toBe('super_admin');
    expect(SYSTEM_DEFAULT_ROLES.USER_ADMIN).toBe('user_admin');
    expect(SYSTEM_DEFAULT_ROLES.AI_ADMIN).toBe('ai_admin');
  });

  it('treats platform_ codes as ALL-only via isPlatformPermissionCode', () => {
    expect(isPlatformPermissionCode('platform_user:read:all')).toBe(true);
    expect(isPlatformPermissionCode('agent:create:all')).toBe(false);
    expect(isPlatformPermissionCode('platform_user:read:owner')).toBe(false);
  });

  it('keeps existing non-platform scope policy (regression)', () => {
    expect(getAllowedScopesForAction('RBAC_ROLE_READ')).toEqual(['ALL']);
    expect(getAllowedScopesForAction('WORKSPACE_READ')).toEqual(['ALL']);
    expect(getAllowedScopesForAction('AGENT_CREATE')).toEqual(['ALL', 'OWNER']);
  });
});
