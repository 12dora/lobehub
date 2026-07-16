import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSION_LIST, PLATFORM_PERMISSIONS } from './permissions';

describe('platform permissions catalog', () => {
  it('uses platform_ resource:action:all shape', () => {
    for (const code of PLATFORM_PERMISSION_LIST) {
      expect(code.startsWith('platform_')).toBe(true);
      expect(code.endsWith(':all')).toBe(true);
      expect(code.includes(':')).toBe(true);
    }
  });

  it('includes admin access, audit, and role codes', () => {
    expect(PLATFORM_PERMISSIONS.ADMIN_ACCESS).toBe('platform_admin:access:all');
    expect(PLATFORM_PERMISSIONS.AUDIT_READ).toBe('platform_audit:read:all');
    expect(PLATFORM_PERMISSIONS.ROLE_READ).toBe('platform_role:read:all');
    expect(PLATFORM_PERMISSIONS.ROLE_UPDATE).toBe('platform_role:update:all');
  });
});
