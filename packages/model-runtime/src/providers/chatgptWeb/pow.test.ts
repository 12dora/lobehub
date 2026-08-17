import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_BROWSER_DEVICE_PROFILE, resolveProfileTimezone } from '../../browserProfile';
import { decodeBase64Utf8 } from './binary';
import {
  buildPowNavigatorKeys,
  DEFAULT_POW_SCRIPT,
  POW_CONFIG_PREFIX,
  POW_PROOF_PREFIX,
} from './constants';
import { ChatGPTWebError } from './errors';
import {
  buildLegacyRequirementsToken,
  buildPowConfig,
  parsePowResources,
  solveProofToken,
} from './pow';

const PROFILE = DEFAULT_BROWSER_DEVICE_PROFILE;
const USER_AGENT = PROFILE.userAgent;

describe('parsePowResources', () => {
  it('collects script sources and the build marker from a src', () => {
    const html = `<html data-build="prod-fallback"><head>
      <script src="https://cdn.oaistatic.com/assets/a.js"></script>
      <script src="/_next/static/c/1a2b3c/_buildManifest.js"></script>
    </head></html>`;

    const { dataBuild, scriptSources } = parsePowResources(html);

    expect(scriptSources).toEqual([
      'https://cdn.oaistatic.com/assets/a.js',
      '/_next/static/c/1a2b3c/_buildManifest.js',
    ]);
    expect(dataBuild).toBe('c/1a2b3c/_');
  });

  it('falls back to the html data-build attribute', () => {
    const { dataBuild, scriptSources } = parsePowResources(
      '<html data-build="prod-abc"><script src="/x.js"></script></html>',
    );

    expect(dataBuild).toBe('prod-abc');
    expect(scriptSources).toEqual(['/x.js']);
  });

  it('falls back to the default sdk script when the page has no scripts', () => {
    expect(parsePowResources('<html></html>')).toEqual({
      dataBuild: '',
      scriptSources: [DEFAULT_POW_SCRIPT],
    });
  });
});

describe('buildPowConfig', () => {
  it('produces the 25-slot fingerprint array', () => {
    const config = buildPowConfig({
      browserProfile: PROFILE,
      dataBuild: 'c/abc/_',
      scriptSources: ['https://example.com/a.js'],
      userAgent: USER_AGENT,
    });

    expect(config).toHaveLength(25);
    expect(config[2]).toBe(4_294_705_152);
    expect(config[3]).toBe(1);
    expect(config[4]).toBe(USER_AGENT);
    expect(config[5]).toBe('https://example.com/a.js');
    expect(config[6]).toBe('c/abc/_');
    expect(config[7]).toBe(PROFILE.languages[0]);
    expect(config[8]).toBe(PROFILE.languages.join(','));
    expect(config[15]).toBe('');
    expect(config.slice(18)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(String(config[1]).endsWith(resolveProfileTimezone(PROFILE).jsDateSuffix)).toBe(true);
    expect(config[16]).toBe(PROFILE.hardwareConcurrency);
    expect(config[0]).toBe(PROFILE.screen.width + PROFILE.screen.height);
    const navigatorKeys = buildPowNavigatorKeys(PROFILE);
    expect(
      navigatorKeys.some((key) =>
        key.endsWith(`hardwareConcurrency\u2212${PROFILE.hardwareConcurrency}`),
      ),
    ).toBe(true);
    expect(navigatorKeys.some((key) => key.endsWith(`language\u2212${PROFILE.languages[0]}`))).toBe(
      true,
    );
  });
});

describe('buildPowConfig timezone', () => {
  it.each([
    ['2026-08-01T12:00:00Z', 'GMT-0400 (Eastern Daylight Time)', 8],
    ['2026-01-15T12:00:00Z', 'GMT-0500 (Eastern Standard Time)', 7],
  ])(
    'writes the live DST offset and zone name of the profile at %s',
    (now, expectedSuffix, expectedHour) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      try {
        const easternProfile = {
          ...PROFILE,
          timezone: {
            iana: 'America/New_York',
            jsDateSuffix: 'GMT-0500 (Eastern Standard Time)',
            offsetKind: 'standard' as const,
            offsetMinutes: 300,
          },
        };
        const config = buildPowConfig({ browserProfile: easternProfile, userAgent: USER_AGENT });

        // The wall clock and the zone label must agree: 12:00 UTC is 08:00 EDT / 07:00 EST.
        expect(String(config[1])).toContain(` ${String(expectedHour).padStart(2, '0')}:00:00 `);
        expect(String(config[1]).endsWith(expectedSuffix)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('buildLegacyRequirementsToken', () => {
  it('is the base64 config array behind the gAAAAAC prefix', () => {
    const token = buildLegacyRequirementsToken({ browserProfile: PROFILE, userAgent: USER_AGENT });

    expect(token.startsWith(POW_CONFIG_PREFIX)).toBe(true);
    const decoded = JSON.parse(decodeBase64Utf8(token.slice(POW_CONFIG_PREFIX.length)));
    expect(decoded).toHaveLength(25);
    expect(decoded[4]).toBe(USER_AGENT);
  });
});

describe('solveProofToken', () => {
  const config = buildPowConfig({ browserProfile: PROFILE, userAgent: USER_AGENT });

  it('solves a trivial difficulty and returns the gAAAAAB token', async () => {
    const token = await solveProofToken({ config, difficulty: 'ffff', seed: 'seed-1' });

    expect(token.startsWith(POW_PROOF_PREFIX)).toBe(true);
    const payload = JSON.parse(decodeBase64Utf8(token.slice(POW_PROOF_PREFIX.length)));
    expect(payload).toHaveLength(25);
    // slots 3 and 9 carry the iteration counter and (counter >> 1)
    expect(payload[3]).toBe(0);
    expect(payload[9]).toBe(0);
    expect(payload[4]).toBe(USER_AGENT);
  });

  it('throws a pow error when the iteration cap is reached', async () => {
    await expect(
      solveProofToken({ config, difficulty: '0000', limit: 25, seed: 'seed-2' }),
    ).rejects.toMatchObject({ kind: 'pow' });
  });

  it('yields to the event loop so the cap cannot freeze it', async () => {
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);

    await expect(
      solveProofToken({
        config,
        difficulty: '0000',
        limit: 6,
        seed: 'seed-3',
        yieldEvery: 2,
      }),
    ).rejects.toBeInstanceOf(ChatGPTWebError);

    expect(ticked).toBe(true);
  });

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      solveProofToken({ config, difficulty: '0000', seed: 'seed-4', signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});
