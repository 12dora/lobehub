import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DISABLED_PLATFORM_PUBLIC_SNAPSHOT } from '@/types/platform/publicSnapshot';

const injectSnapshot = (themeDefaults: unknown) => {
  window.__SERVER_CONFIG__ = {
    analyticsConfig: {},
    clientEnv: {},
    config: {},
    featureFlags: {},
    isMobile: false,
    platformPublicSnapshot: {
      ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
      branding: {
        defaultAgentDisplayName: null,
        emailFrom: null,
        emailSenderName: null,
        faviconUrl: null,
        homeUrl: null,
        iconUrl: null,
        legalName: null,
        logoUrl: '/aihub.png',
        name: 'AIHub',
        ogImageUrl: null,
        pageTitleTemplate: null,
        privacyUrl: null,
        revision: '4',
        shortName: null,
        supportUrl: null,
        termsUrl: null,
        ...(themeDefaults === undefined ? {} : { themeDefaults }),
      },
      brandingRevision: '4',
      logoUrl: '/aihub.png',
      platformName: 'AIHub',
    },
  } as never;
};

const importModule = async () => {
  vi.resetModules();

  return import('./platformThemeDefaults');
};

beforeEach(() => {
  window.__SERVER_CONFIG__ = undefined;
});

afterEach(() => {
  window.__SERVER_CONFIG__ = undefined;
});

describe('platformThemeDefaults', () => {
  it('seeds the first paint from the server-injected snapshot', async () => {
    injectSnapshot({ primaryColor: '#E4002B' });

    const { getPlatformDefaultPrimaryColor } = await importModule();

    expect(getPlatformDefaultPrimaryColor()).toBe('#E4002B');
  });

  it.each([undefined, { primaryColor: null }, { primaryColor: 'chartreuse' }])(
    'starts without a colour for injected theme defaults %o',
    async (themeDefaults) => {
      injectSnapshot(themeDefaults);

      const { getPlatformDefaultPrimaryColor } = await importModule();

      expect(getPlatformDefaultPrimaryColor()).toBeNull();
    },
  );

  it('starts without a colour when nothing is injected', async () => {
    const { getPlatformDefaultPrimaryColor } = await importModule();

    expect(getPlatformDefaultPrimaryColor()).toBeNull();
  });

  it('notifies subscribers only when the sanitized value changes', async () => {
    const { setPlatformDefaultPrimaryColor, usePlatformDefaultPrimaryColor } = await importModule();
    const { renderHook } = await import('@testing-library/react');
    const { act } = await import('react');

    const { result } = renderHook(() => usePlatformDefaultPrimaryColor());
    expect(result.current).toBeNull();

    await act(async () => setPlatformDefaultPrimaryColor('  #E4002B  '));
    expect(result.current).toBe('#E4002B');

    await act(async () => setPlatformDefaultPrimaryColor('not-a-colour'));
    expect(result.current).toBeNull();
  });
});
