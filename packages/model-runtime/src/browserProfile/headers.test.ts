import { describe, expect, it } from 'vitest';

import { generateBrowserDeviceProfile } from './generate';
import {
  ACCEPT_NAVIGATE,
  buildClientHintHeaders,
  buildFetchMetadataHeaders,
  deriveViewportWidth,
  userAgentHeaders,
} from './headers';

const profile = generateBrowserDeviceProfile({ seed: 'header-profile' });

describe('browser profile header derivations', () => {
  it('builds low- and high-entropy hints from one coherent profile', () => {
    const low = buildClientHintHeaders(profile, { entropy: 'low' });
    const high = buildClientHintHeaders(profile, { entropy: 'high' });

    expect(low).toEqual({
      'Sec-Ch-Ua': profile.secChUa,
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': `"${profile.platform}"`,
    });
    expect(high).toMatchObject({
      ...low,
      // Raw, uncapped: real Chrome 150 reports `device-memory: 32` on a 32 GiB machine.
      'Device-Memory': String(profile.deviceMemoryGiB),
      'Dpr': String(profile.screen.dpr),
      'Sec-Ch-Ua-Arch': `"${profile.arch}"`,
      'Sec-Ch-Ua-Full-Version': `"${profile.chrome.fullVersion}"`,
      'Sec-Ch-Ua-Full-Version-List': profile.secChUaFullVersionList,
      'Sec-Ch-Ua-Platform-Version': `"${profile.platformVersion}"`,
      'Sec-Ch-Prefers-Color-Scheme': profile.prefersColorScheme,
      'Sec-Ch-Prefers-Reduced-Motion': profile.prefersReducedMotion,
      'Viewport-Width': String(deriveViewportWidth(profile)),
    });
    // Network-quality hints are never emitted: nothing delegates them.
    for (const hint of ['rtt', 'downlink', 'ect']) expect(high).not.toHaveProperty(hint);
  });

  it('derives a per-profile window width instead of one constant for every install', () => {
    const widths = new Set(
      Array.from({ length: 40 }, (_, index) =>
        deriveViewportWidth(generateBrowserDeviceProfile({ seed: `viewport-${index}` })),
      ),
    );

    expect(widths.size).toBeGreaterThan(5);
    for (let index = 0; index < 40; index += 1) {
      const candidate = generateBrowserDeviceProfile({ seed: `viewport-${index}` });
      const width = deriveViewportWidth(candidate);
      expect(width).toBe(deriveViewportWidth(candidate));
      expect(width).toBeLessThanOrEqual(candidate.screen.availWidth);
      expect(width).toBeGreaterThanOrEqual(Math.round(candidate.screen.availWidth * 0.8) - 1);
    }
  });

  it('does not emit DNT when the generated profile has it disabled', () => {
    expect(userAgentHeaders({ ...profile, dnt: false })).not.toHaveProperty('DNT');
    expect(userAgentHeaders({ ...profile, dnt: true })).toHaveProperty('DNT', '1');
  });

  it('builds navigation and XHR fetch metadata without provider-specific names', () => {
    expect(buildFetchMetadataHeaders('navigate')).toMatchObject({
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    });
    expect(buildFetchMetadataHeaders('xhr')).toEqual({
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    });
    expect(ACCEPT_NAVIGATE).toContain('text/html');
  });
});
