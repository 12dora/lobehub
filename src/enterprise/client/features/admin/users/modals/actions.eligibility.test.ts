import { describe, expect, it } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import { getEligibleAssignableRoles } from './actions';

describe('getEligibleAssignableRoles', () => {
  it('user_admin never receives super_admin', () => {
    const roles = getEligibleAssignableRoles([{ name: PLATFORM_SYSTEM_ROLES.USER_ADMIN }]);
    expect(roles).not.toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(roles).toContain(PLATFORM_SYSTEM_ROLES.USER_ADMIN);
  });

  it('super_admin may assign permanent super_admin', () => {
    const roles = getEligibleAssignableRoles([{ name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN }]);
    expect(roles).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
  });
});

describe('role localization keys', () => {
  it('every assignable role has desc + impact i18n keys in en-US admin.json', async () => {
    const en = await import('../../../../../../../locales/en-US/admin.json');
    const data = (en as { default: Record<string, string> }).default;
    for (const role of Object.values(PLATFORM_SYSTEM_ROLES)) {
      expect(data[`users.roles.desc.${role}`]).toBeTruthy();
      expect(data[`users.roles.impact.${role}`]).toBeTruthy();
      expect(String(data[`users.roles.desc.${role}`]).length).toBeGreaterThan(10);
    }
  });
});
