import { describe, expect, it } from 'vitest';

import { DISABLED_PLATFORM_PUBLIC_SNAPSHOT } from './publicSnapshot';

describe('PlatformPublicSnapshot', () => {
  it('defaults to no branding and no work-account login', () => {
    expect(DISABLED_PLATFORM_PUBLIC_SNAPSHOT.platformName).toBeNull();
    expect(DISABLED_PLATFORM_PUBLIC_SNAPSHOT.logoUrl).toBeNull();
    expect(DISABLED_PLATFORM_PUBLIC_SNAPSHOT.login.workAccountEnabled).toBe(false);
    expect(DISABLED_PLATFORM_PUBLIC_SNAPSHOT.configRevision).toBe('0');
  });

  it('does not carry secrets or admin fields', () => {
    expect(DISABLED_PLATFORM_PUBLIC_SNAPSHOT).not.toHaveProperty('clientSecret');
    expect(DISABLED_PLATFORM_PUBLIC_SNAPSHOT).not.toHaveProperty('adminAccess');
    expect(DISABLED_PLATFORM_PUBLIC_SNAPSHOT).not.toHaveProperty('roles');
  });
});
