import { describe, expect, it } from 'vitest';

import { buildEasyauthDescriptor, buildEasyauthManifest } from './easyauthManifest';
import { AIHUB_ACCESS_PERMISSION } from './permissions';
import { PLATFORM_SYSTEM_ROLES } from './roles';

describe('easyauth manifest', () => {
  it('builds a valid-shaped descriptor for app_key=aihub', () => {
    const descriptor = buildEasyauthDescriptor({ schemaVersion: 1 });
    expect(descriptor.descriptor_version).toBe(1);
    expect(descriptor.app.app_key).toBe('aihub');
    expect(descriptor.manifest.schema_version).toBe(1);
    expect(descriptor.manifest.permissions.some((p) => p.key === AIHUB_ACCESS_PERMISSION)).toBe(
      true,
    );
    // super_admin never published
    const groupKeys = descriptor.manifest.authorization_groups.map((g) => String(g.key));
    expect(groupKeys.includes('super_admin')).toBe(false);
  });

  it('includes managed role authorization groups', () => {
    const manifest = buildEasyauthManifest();
    const keys = manifest.authorization_groups.map((g) => String(g.key));
    expect(keys).toContain(PLATFORM_SYSTEM_ROLES.USER_ADMIN);
    expect(keys).toContain(PLATFORM_SYSTEM_ROLES.AUDITOR);
    expect(keys.includes('super_admin')).toBe(false);
  });
});
