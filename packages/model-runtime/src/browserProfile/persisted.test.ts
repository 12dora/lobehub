import { describe, expect, it } from 'vitest';

import {
  deriveChromiumBrandHeaders,
  generateBrowserDeviceProfile,
  validateBrowserDeviceProfile,
} from './generate';
import { isCoherentBrowserDeviceProfile, validateBrowserDeviceProfileShape } from './persisted';

const profile = generateBrowserDeviceProfile({ seed: 'persisted-profile' });

describe('validateBrowserDeviceProfileShape', () => {
  it('accepts a profile that drifted out of the current pools', () => {
    // A retired Chrome build and a repaired platform-version pool must not brick an
    // installation: the (still coherent) identity it presents upstream stays in use.
    const fullVersion = '150.0.7871.1';
    const drifted = {
      ...profile,
      chrome: { ...profile.chrome, fullVersion },
      platformVersion: '11.0.0',
      ...deriveChromiumBrandHeaders(profile.chrome.major, fullVersion),
    };

    expect(() => validateBrowserDeviceProfile(drifted)).toThrow();
    expect(isCoherentBrowserDeviceProfile(drifted)).toBe(false);
    expect(validateBrowserDeviceProfileShape(drifted)).toBe(drifted);
  });

  it('accepts the runtime view, which carries no seed', () => {
    const { seed: _seed, ...runtimeProfile } = profile;

    expect(validateBrowserDeviceProfileShape(runtimeProfile)).toBe(runtimeProfile);
    expect(() => validateBrowserDeviceProfileShape({ ...runtimeProfile, seed: '' })).toThrow(
      /seed/,
    );
  });

  it('rejects a payload that is not a usable profile object', () => {
    expect(() => validateBrowserDeviceProfileShape(undefined)).toThrow(/not an object/);
    expect(() => validateBrowserDeviceProfileShape({ ...profile, schemaVersion: 2 })).toThrow(
      /schemaVersion/,
    );
    expect(() => validateBrowserDeviceProfileShape({ ...profile, id: 'nope' })).toThrow(/UUIDv4/);
    expect(() =>
      validateBrowserDeviceProfileShape({ ...profile, installationId: undefined }),
    ).toThrow(/installationId/);
    expect(() =>
      validateBrowserDeviceProfileShape({ ...profile, impersonateProfile: 'chrome999' }),
    ).toThrow(/curl-impersonate/);
    expect(() => validateBrowserDeviceProfileShape({ ...profile, chrome: {} })).toThrow(
      /fullVersion/,
    );
    expect(() => validateBrowserDeviceProfileShape({ ...profile, languages: [] })).toThrow(
      /languages/,
    );
    expect(() => validateBrowserDeviceProfileShape({ ...profile, screen: {} })).toThrow(/screen/);
    expect(() =>
      validateBrowserDeviceProfileShape({ ...profile, timezone: { iana: 'Asia/Tokyo' } }),
    ).toThrow(/jsDateSuffix/);
    expect(() => validateBrowserDeviceProfileShape({ ...profile, hardwareConcurrency: 0 })).toThrow(
      /hardwareConcurrency/,
    );
  });

  /**
   * These are facts of Chrome and of the desktop, not of any pool: a record that breaks
   * one of them describes a machine nobody has, and keeping it would present that
   * impossible device upstream forever. Each is treated exactly like a shape failure —
   * the caller regenerates.
   */
  it('rejects an internally impossible identity, field by field', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['mobile', { mobile: true }],
      ['model', { model: 'Pixel 8' }],
      ['maxTouchPoints', { maxTouchPoints: 5 }],
      ['wow64', { wow64: true }],
      ['bitness', { bitness: '32' }],
      ['formFactors', { formFactors: ['Desktop', 'Mobile'] }],
      ['vendor', { vendor: 'Apple Computer, Inc.' }],
      // Windows never reports arm through this client-hint surface.
      ['arch on platform', { arch: 'arm', navigatorPlatform: 'Win32', platform: 'Windows' }],
      ['navigator platform', { navigatorPlatform: 'Win32' }],
      [
        'user agent os token',
        {
          userAgent: profile.userAgent.replace(
            'Macintosh; Intel Mac OS X 10_15_7',
            'Windows NT 10.0; Win64; x64',
          ),
        },
      ],
      [
        'user agent major',
        { userAgent: profile.userAgent.replace(`Chrome/${profile.chrome.major}`, 'Chrome/99') },
      ],
      ['chrome full version', { chrome: { ...profile.chrome, fullVersion: '99.0.1.2' } }],
      ['sec-ch-ua', { secChUa: '"Chromium";v="150", "Google Chrome";v="150"' }],
      [
        'GREASE brand order',
        {
          secChUaFullVersionList: profile.secChUaFullVersionList.split(', ').reverse().join(', '),
        },
      ],
      ['device memory', { deviceMemoryGiB: 7 }],
      ['cores', { hardwareConcurrency: 128 }],
      [
        'physically impossible screen',
        {
          screen: {
            availHeight: 1400,
            availWidth: 2555,
            colorDepth: 24,
            dpr: 1,
            height: 1440,
            width: 2555,
          },
        },
      ],
      [
        'available area larger than the screen',
        { screen: { ...profile.screen, availWidth: profile.screen.width + 10 } },
      ],
      ['timezone offsetKind', { timezone: { ...profile.timezone, offsetKind: 'daylight' } }],
      ['timezone offset', { timezone: { ...profile.timezone, offsetMinutes: -5000 } }],
      ['timezone iana', { timezone: { ...profile.timezone, iana: '' } }],
    ];

    // The macOS profile above is the baseline; the Windows case supplies its own platform.
    expect(profile.platform).toBe('macOS');
    for (const [label, override] of cases) {
      expect(() => validateBrowserDeviceProfileShape({ ...profile, ...override }), label).toThrow(
        /Malformed persisted browser device profile/,
      );
    }
  });

  it('accepts every profile the generator can produce', () => {
    for (let index = 0; index < 500; index += 1) {
      const generated = generateBrowserDeviceProfile({ seed: `sweep-${index}` });
      expect(
        () => validateBrowserDeviceProfileShape(generated),
        `seed sweep-${index}`,
      ).not.toThrow();
    }
  });

  it('confirms a freshly generated profile is coherent with the pools', () => {
    expect(isCoherentBrowserDeviceProfile(profile)).toBe(true);
  });
});
