// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import { extractIdentityProviderGroups, resolveMappedPlatformRoles } from './groupRoleMapping';

describe('identity provider groupRoleMapping', () => {
  it('extracts groups from common claim shapes', () => {
    expect(extractIdentityProviderGroups({ groups: ['eng', 'ops'] })).toEqual(['eng', 'ops']);
    expect(extractIdentityProviderGroups({ groups: 'eng' })).toEqual(['eng']);
    expect(extractIdentityProviderGroups({ group: ['qa'] })).toEqual(['qa']);
    expect(extractIdentityProviderGroups({})).toEqual([]);
  });

  it('maps groups to platform roles and always includes platform_user', () => {
    const roles = resolveMappedPlatformRoles({
      groupRoleMapping: {
        admins: PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
        readers: PLATFORM_SYSTEM_ROLES.AUDITOR,
      },
      groups: ['admins', 'readers', 'unknown'],
    });
    expect(roles).toEqual(
      expect.arrayContaining([
        PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
        PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
        PLATFORM_SYSTEM_ROLES.AUDITOR,
      ]),
    );
    expect(roles).toHaveLength(3);
  });

  it('never elevates super_admin via mapping and drops unknown role names', () => {
    const roles = resolveMappedPlatformRoles({
      groupRoleMapping: {
        breakglass: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
        bogus: 'not_a_real_role',
        staff: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
      },
      groups: ['breakglass', 'bogus', 'staff'],
    });
    expect(roles).toEqual(
      expect.arrayContaining([PLATFORM_SYSTEM_ROLES.PLATFORM_USER, PLATFORM_SYSTEM_ROLES.AI_ADMIN]),
    );
    expect(roles).not.toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(roles).not.toContain('not_a_real_role');
  });

  it('returns only platform_user when no groups match', () => {
    expect(
      resolveMappedPlatformRoles({
        groupRoleMapping: { eng: PLATFORM_SYSTEM_ROLES.AI_ADMIN },
        groups: ['other'],
      }),
    ).toEqual([PLATFORM_SYSTEM_ROLES.PLATFORM_USER]);
  });
});
