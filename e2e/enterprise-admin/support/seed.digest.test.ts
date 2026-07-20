import { describe, expect, it } from 'vitest';

import { digestFingerprint, type GlobalDbDigest } from './seed';

describe('global db digest', () => {
  it('fingerprints are stable for equal digests and diverge on mutation', () => {
    const a: GlobalDbDigest = {
      managedPolicies: [
        {
          config: '{"draft":{},"published":{}}',
          enforcement: 'enforced',
          resource: 'skills',
          revision: 1,
          status: 'published',
        },
      ],
      platformRolePermissions: [
        { permissionCode: 'platform_admin:access:all', roleName: 'auditor' },
      ],
      platformRoles: [{ id: 'r1', name: 'auditor' }],
    };
    const b = structuredClone(a);
    expect(digestFingerprint(a)).toBe(digestFingerprint(b));
    b.managedPolicies[0].revision = 2;
    expect(digestFingerprint(a)).not.toBe(digestFingerprint(b));
  });
});
