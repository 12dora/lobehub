import { describe, expect, it } from 'vitest';

import {
  digestFingerprint,
  type GlobalDbDigest,
  type ManagedPolicyRow,
  type SuiteGlobalWriteManifest,
} from './seed';

const policy = (over: Partial<ManagedPolicyRow> = {}): ManagedPolicyRow => ({
  config: '{"draft":{},"published":{}}',
  enforcement: 'enforced',
  id: 'pmrp_skills_1',
  resource: 'skills',
  revision: 1,
  status: 'published',
  ...over,
});

describe('global db digest', () => {
  it('fingerprints are stable for equal digests and diverge on mutation', () => {
    const a: GlobalDbDigest = {
      managedPolicies: [policy()],
      platformPermissions: [{ code: 'platform_admin:access:all', id: 'p1' }],
      platformRolePermissions: [
        {
          permissionCode: 'platform_admin:access:all',
          permissionId: 'p1',
          roleId: 'r1',
          roleName: 'auditor',
        },
      ],
      platformRoles: [{ id: 'r1', name: 'auditor' }],
    };
    const b = structuredClone(a);
    expect(digestFingerprint(a)).toBe(digestFingerprint(b));
    b.managedPolicies[0].revision = 2;
    expect(digestFingerprint(a)).not.toBe(digestFingerprint(b));
  });

  it('suite write manifest tracks created rows with after fingerprints for CAS', () => {
    const before: GlobalDbDigest = {
      managedPolicies: [policy({ enforcement: 'observe', revision: 1 })],
      platformPermissions: [],
      platformRolePermissions: [],
      platformRoles: [],
    };
    const afterPolicy = policy({ enforcement: 'enforced', revision: 2 });
    const after: GlobalDbDigest = {
      managedPolicies: [afterPolicy],
      platformPermissions: [{ code: 'platform_admin:access:all', id: 'perm_new' }],
      platformRolePermissions: [],
      platformRoles: [{ id: 'role_new', name: 'super_admin' }],
    };
    const manifest: SuiteGlobalWriteManifest = {
      after,
      before,
      createdPermissions: [
        {
          code: 'platform_admin:access:all',
          fingerprint: 'fp-perm',
          id: 'perm_new',
        },
      ],
      createdPolicies: [],
      createdRolePermissionKeys: [],
      createdRoles: [{ fingerprint: 'fp-role', id: 'role_new', name: 'super_admin' }],
      mutatedPolicies: [{ after: afterPolicy, before: before.managedPolicies[0] }],
    };
    expect(manifest.createdPermissions[0].id).toBe('perm_new');
    expect(manifest.createdRoles[0].fingerprint).toBe('fp-role');
    expect(manifest.mutatedPolicies[0].before.enforcement).toBe('observe');
    expect(digestFingerprint(manifest.before)).not.toBe(digestFingerprint(manifest.after));
  });
});
