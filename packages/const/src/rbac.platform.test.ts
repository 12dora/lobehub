import { describe, expect, it } from 'vitest';

import { getAllowedScopesForAction, isPlatformPermissionCode, SYSTEM_DEFAULT_ROLES } from './rbac';

describe('rbac platform scope rules (M02)', () => {
  it('keeps SYSTEM_DEFAULT_ROLES limited to legacy super_admin (platform roles are separate)', () => {
    expect(SYSTEM_DEFAULT_ROLES.SUPER_ADMIN).toBe('super_admin');
    expect(Object.keys(SYSTEM_DEFAULT_ROLES)).toEqual(['SUPER_ADMIN']);
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
