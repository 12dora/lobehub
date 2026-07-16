import { afterEach, describe, expect, it } from 'vitest';

import { isPlatformAdminBootEnabled } from './isPlatformAdminBootEnabled';

describe('isPlatformAdminBootEnabled', () => {
  afterEach(() => {
    window.__SERVER_CONFIG__ = undefined;
  });

  it('is false when boot config is absent', () => {
    window.__SERVER_CONFIG__ = undefined;
    expect(isPlatformAdminBootEnabled()).toBe(false);
  });

  it('is false when enterprise.platformAdmin is missing or false', () => {
    window.__SERVER_CONFIG__ = {
      analyticsConfig: {},
      clientEnv: {},
      config: { enterprise: { enabled: true, platformAdmin: false } },
      featureFlags: {},
      isMobile: false,
    } as any;
    expect(isPlatformAdminBootEnabled()).toBe(false);

    window.__SERVER_CONFIG__ = {
      analyticsConfig: {},
      clientEnv: {},
      config: { enterprise: { enabled: true } },
      featureFlags: {},
      isMobile: false,
    } as any;
    expect(isPlatformAdminBootEnabled()).toBe(false);
  });

  it('is true only when enterprise.platformAdmin is true', () => {
    window.__SERVER_CONFIG__ = {
      analyticsConfig: {},
      clientEnv: {},
      config: { enterprise: { enabled: true, platformAdmin: true } },
      featureFlags: {},
      isMobile: false,
    } as any;
    expect(isPlatformAdminBootEnabled()).toBe(true);
  });
});
