import { describe, expect, it } from 'vitest';

import {
  canonicalizeJson,
  digestFingerprint,
  type GlobalDbDigest,
  type ManagedPolicyRow,
  permissionFingerprint,
  roleFingerprint,
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

  it('role/permission fingerprints include metadata and timestamps', () => {
    const roleBase = {
      createdAt: '2026-01-01T00:00:00.000Z',
      description: 'platform super_admin',
      displayName: 'super_admin',
      id: 'role_1',
      isActive: true,
      isSystem: true,
      metadata: canonicalizeJson({}),
      name: 'super_admin',
      updatedAt: '2026-01-01T00:00:00.000Z',
      workspaceId: null as null,
    };
    expect(roleFingerprint(roleBase)).not.toBe(
      roleFingerprint({ ...roleBase, metadata: canonicalizeJson({ foreign: true }) }),
    );
    expect(roleFingerprint(roleBase)).not.toBe(
      roleFingerprint({ ...roleBase, updatedAt: '2026-01-02T00:00:00.000Z' }),
    );

    const permBase = {
      category: 'platform',
      code: 'platform_admin:access:all',
      createdAt: '2026-01-01T00:00:00.000Z',
      description: 'x',
      id: 'p1',
      isActive: true,
      name: 'platform_admin:access:all',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(permissionFingerprint(permBase)).not.toBe(
      permissionFingerprint({ ...permBase, updatedAt: '2026-01-02T00:00:00.000Z' }),
    );
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
          category: 'platform',
          code: 'platform_admin:access:all',
          createdAt: '2026-01-01T00:00:00.000Z',
          description: 'x',
          fingerprint: 'fp-perm',
          id: 'perm_new',
          isActive: true,
          name: 'platform_admin:access:all',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      createdPolicies: [],
      createdRolePermissionKeys: [],
      createdUserRoles: [],
      createdRoles: [
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          description: 'd',
          displayName: 'super_admin',
          fingerprint: 'fp-role',
          id: 'role_new',
          isActive: true,
          isSystem: true,
          metadata: '{}',
          name: 'super_admin',
          updatedAt: '2026-01-01T00:00:00.000Z',
          workspaceId: null,
        },
      ],
      mutatedPolicies: [{ after: afterPolicy, before: before.managedPolicies[0] }],
    };
    expect(manifest.createdPermissions[0].id).toBe('perm_new');
    expect(manifest.createdRoles[0].metadata).toBe('{}');
  });
});
