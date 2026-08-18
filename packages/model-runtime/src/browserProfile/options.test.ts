import { describe, expect, it } from 'vitest';

import {
  generateBrowserDeviceProfile,
  IMPERSONATE_CHROME_PROFILES,
  LOCALE_BUNDLES,
  PLATFORM_DEFINITIONS,
  validateBrowserDeviceProfile,
} from './generate';
import {
  BrowserProfileOptionError,
  browserProfileOptionId,
  composeBrowserDeviceProfileFromOptions,
  listBrowserProfileOptions,
  resolveBrowserProfileOptionIds,
  sampleValidBrowserProfileCompositions,
} from './options';

const identity = {
  dnt: false,
  id: '11111111-1111-4111-8111-111111111111',
  installationId: '22222222-2222-4222-8222-222222222222',
  prefersColorScheme: 'light' as const,
  prefersReducedMotion: 'no-preference' as const,
  seed: 'browser-profile-option-test',
};

describe('browser profile options', () => {
  it('derives every catalog entry from the generator pools', () => {
    const options = listBrowserProfileOptions();

    expect(options.chrome.map((item) => item.impersonateProfile)).toEqual(
      IMPERSONATE_CHROME_PROFILES.map((item) => item.id),
    );
    expect(options.locales).toHaveLength(LOCALE_BUNDLES.length);
    expect(options.systems).toHaveLength(
      PLATFORM_DEFINITIONS.reduce(
        (sum, definition) =>
          sum + definition.architectures.length * definition.platformVersions.length,
        0,
      ),
    );
    expect(options.screens).toHaveLength(
      PLATFORM_DEFINITIONS.reduce((sum, definition) => sum + definition.screens.length, 0),
    );

    for (const chrome of options.chrome) {
      const profile = IMPERSONATE_CHROME_PROFILES.find(
        (item) => item.id === chrome.impersonateProfile,
      );
      expect(profile).toBeDefined();
      expect(chrome.major).toBe(profile!.major);
      expect(profile!.fullVersions).toContain(chrome.fullVersion);
      expect(chrome.label).toBe(`Chrome ${chrome.major}`);
    }

    for (const locale of options.locales) {
      expect(
        LOCALE_BUNDLES.some(
          (bundle) =>
            bundle.acceptLanguage === locale.acceptLanguage &&
            bundle.timezone.iana === locale.timezone,
        ),
      ).toBe(true);
    }
  });

  it('uses content-derived ids that survive a pool reorder', () => {
    const options = listBrowserProfileOptions();
    const reversedChrome = [...IMPERSONATE_CHROME_PROFILES].reverse();

    expect(options.chrome.map((item) => item.id)).not.toEqual(
      options.chrome.map((_, index) => String(index)),
    );

    for (const profile of reversedChrome) {
      const option = options.chrome.find((item) => item.impersonateProfile === profile.id);
      expect(option?.id).toBe(browserProfileOptionId(profile.id));
    }

    const reversedLocales = [...LOCALE_BUNDLES].reverse();
    for (const bundle of reversedLocales) {
      const option = options.locales.find(
        (item) =>
          item.acceptLanguage === bundle.acceptLanguage && item.timezone === bundle.timezone.iana,
      );
      expect(option?.id).toBe(browserProfileOptionId(bundle.acceptLanguage, bundle.timezone.iana));
    }

    const first = listBrowserProfileOptions();
    const second = listBrowserProfileOptions();
    expect(second).toEqual(first);
  });

  it('composes every catalog option into a strictly valid profile', () => {
    const samples = sampleValidBrowserProfileCompositions();
    expect(samples.length).toBeGreaterThan(0);
    for (const profile of samples) {
      expect(validateBrowserDeviceProfile(profile)).toBe(profile);
    }
  });

  it('resolves selected ids for a freshly generated profile', () => {
    for (let index = 0; index < 40; index += 1) {
      const profile = generateBrowserDeviceProfile({ seed: `option-resolve-${index}` });
      const ids = resolveBrowserProfileOptionIds(profile);
      expect(ids).toEqual({
        chromeId: expect.any(String),
        computeId: expect.any(String),
        localeId: expect.any(String),
        screenId: expect.any(String),
        systemId: expect.any(String),
        webglId: expect.any(String),
      });
      const composed = composeBrowserDeviceProfileFromOptions(ids as never, identity, profile);
      expect(resolveBrowserProfileOptionIds(composed)).toEqual(ids);
    }
  });

  it('rejects an unknown option id and a platform-incompatible combination', () => {
    const options = listBrowserProfileOptions();
    const windows = options.systems.find((item) => item.platform === 'Windows');
    const macArmGpu = options.webgl.find(
      (item) => item.platform === 'macOS' && item.arch === 'arm',
    );
    const macArmMemory = options.compute.find(
      (item) => item.platform === 'macOS' && item.arch === 'arm' && item.memoryGiB === 24,
    );
    const windowsScreen = options.screens.find((item) => item.platform === 'Windows');
    const windowsCompute = options.compute.find(
      (item) => item.platform === 'Windows' && item.arch === 'x86',
    );
    const windowsGpu = options.webgl.find((item) => item.platform === 'Windows');

    expect(
      windows && macArmGpu && macArmMemory && windowsScreen && windowsCompute && windowsGpu,
    ).toBeTruthy();

    expect(() =>
      composeBrowserDeviceProfileFromOptions(
        {
          chromeId: 'not-a-chrome',
          computeId: windowsCompute!.id,
          localeId: options.locales[0]!.id,
          screenId: windowsScreen!.id,
          systemId: windows!.id,
          webglId: windowsGpu!.id,
        },
        identity,
      ),
    ).toThrow(BrowserProfileOptionError);

    expect(() =>
      composeBrowserDeviceProfileFromOptions(
        {
          chromeId: options.chrome[0]!.id,
          computeId: windowsCompute!.id,
          localeId: options.locales[0]!.id,
          screenId: windowsScreen!.id,
          systemId: windows!.id,
          webglId: macArmGpu!.id,
        },
        identity,
      ),
    ).toThrow(/WebGL option does not match/);

    expect(() =>
      composeBrowserDeviceProfileFromOptions(
        {
          chromeId: options.chrome[0]!.id,
          computeId: macArmMemory!.id,
          localeId: options.locales[0]!.id,
          screenId: windowsScreen!.id,
          systemId: windows!.id,
          webglId: windowsGpu!.id,
        },
        identity,
      ),
    ).toThrow(/Compute option does not match/);
  });

  it('keeps an already-pooled Chrome fullVersion when the same major is reselected', () => {
    const profile = generateBrowserDeviceProfile({ seed: 'keep-full-version' });
    const ids = resolveBrowserProfileOptionIds(profile);
    const option = listBrowserProfileOptions().chrome.find((item) => item.id === ids.chromeId);

    expect(ids.chromeId).toBeTruthy();
    expect(option).toBeDefined();

    const composed = composeBrowserDeviceProfileFromOptions(ids as never, identity, profile);
    expect(composed.chrome.fullVersion).toBe(profile.chrome.fullVersion);
    expect(composed.impersonateProfile).toBe(profile.impersonateProfile);
  });
});
