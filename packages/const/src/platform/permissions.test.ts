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

  it('includes admin access, audit, stats, and role codes', () => {
    expect(PLATFORM_PERMISSIONS.ADMIN_ACCESS).toBe('platform_admin:access:all');
    expect(PLATFORM_PERMISSIONS.AUDIT_READ).toBe('platform_audit:read:all');
    expect(PLATFORM_PERMISSIONS.AUDIT_EXPORT).toBe('platform_audit:export:all');
    expect(PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ).toBe(
      'platform_audit:conversation_read:all',
    );
    expect(PLATFORM_PERMISSIONS.AUDIT_POLICY_UPDATE).toBe('platform_audit:policy_update:all');
    expect(PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE).toBe(
      'platform_audit:retention_operate:all',
    );
    expect(PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE).toBe(
      'platform_audit:legal_hold_manage:all',
    );
    expect(PLATFORM_PERMISSIONS.STATS_READ).toBe('platform_stats:read:all');
    expect(PLATFORM_PERMISSIONS.ROLE_READ).toBe('platform_role:read:all');
    expect(PLATFORM_PERMISSIONS.ROLE_UPDATE).toBe('platform_role:update:all');
  });
});
