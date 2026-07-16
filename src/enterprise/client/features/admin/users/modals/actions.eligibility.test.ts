import { describe, expect, it } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import { getEligibleAssignableRoles } from './actions';

describe('getEligibleAssignableRoles', () => {
  it('user_admin never receives super_admin', () => {
    const roles = getEligibleAssignableRoles([{ name: PLATFORM_SYSTEM_ROLES.USER_ADMIN }]);
    expect(roles).not.toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(roles).toContain(PLATFORM_SYSTEM_ROLES.USER_ADMIN);
  });

  it('super_admin may assign super_admin', () => {
    const roles = getEligibleAssignableRoles([{ name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN }]);
    expect(roles).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
  });
});
