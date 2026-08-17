import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BROWSER_DEVICE_PROFILE,
  DEFAULT_BROWSER_DEVICE_PROFILE_SEED,
  deriveChromiumBrandHeaders,
  generateBrowserDeviceProfile,
  IMPERSONATE_CHROME_PROFILES,
  isPhysicallyPlausibleScreen,
  validateBrowserDeviceProfile,
} from './generate';
import {
  deriveConversationSessionId,
  deriveCursorConversationId,
  deriveGrokAgentId,
  deriveStableMachineId,
  deriveUuidV4FromName,
} from './identity';

describe('generateBrowserDeviceProfile', () => {
  it('is deterministic for the same seed and preferences', () => {
    const input = { preferences: { localeHint: 'ja-JP' }, seed: 'installation-a' } as const;

    expect(generateBrowserDeviceProfile(input)).toEqual(generateBrowserDeviceProfile(input));
    expect(generateBrowserDeviceProfile(input)).not.toEqual(
      generateBrowserDeviceProfile({ ...input, seed: 'installation-b' }),
    );
    expect(generateBrowserDeviceProfile(input).installationId).not.toBe(
      generateBrowserDeviceProfile(input).id,
    );
  });

  it('generates coherent profiles across a broad seed sample', () => {
    for (let index = 0; index < 500; index += 1) {
      const profile = generateBrowserDeviceProfile({ seed: `coherence-${index}` });
      expect(validateBrowserDeviceProfile(profile)).toBe(profile);
    }
  });

  it('makes every pinned impersonate profile reachable', () => {
    const reached = new Set(
      Array.from({ length: 2000 }, (_, index) =>
        generateBrowserDeviceProfile({ seed: `distribution-${index}` }),
      ).map((profile) => profile.impersonateProfile),
    );

    expect(reached).toEqual(new Set(IMPERSONATE_CHROME_PROFILES.map(({ id }) => id)));
  });

  it('rejects a profile whose Chrome identity no longer agrees', () => {
    const profile = generateBrowserDeviceProfile({ seed: 'tampered' });

    expect(() =>
      validateBrowserDeviceProfile({
        ...profile,
        chrome: { ...profile.chrome, major: profile.chrome.major + 1 },
      }),
    ).toThrow(/Chrome major does not match impersonate profile/);
  });

  it('rejects a profile with a malformed installation id', () => {
    const profile = generateBrowserDeviceProfile({ seed: 'tampered-installation-id' });

    expect(() =>
      validateBrowserDeviceProfile({ ...profile, installationId: profile.id }),
    ).not.toThrow();
    expect(() =>
      validateBrowserDeviceProfile({ ...profile, installationId: 'not-a-uuid' }),
    ).toThrow(/installationId is not a UUIDv4/);
  });

  it('rejects Apple-Silicon-only hardware facts on an x86 Mac profile', () => {
    const profile = generateBrowserDeviceProfile({ seed: 'mac-x86-13' });
    expect(profile).toMatchObject({ arch: 'x86', platform: 'macOS' });

    expect(() => validateBrowserDeviceProfile({ ...profile, deviceMemoryGiB: 36 })).toThrow(
      /device memory is outside the platform pool/,
    );
    expect(() => validateBrowserDeviceProfile({ ...profile, hardwareConcurrency: 14 })).toThrow(
      /hardwareConcurrency is outside the platform pool/,
    );
  });

  it('keeps the degraded fallback stable and valid', () => {
    expect(DEFAULT_BROWSER_DEVICE_PROFILE.seed).toBe(DEFAULT_BROWSER_DEVICE_PROFILE_SEED);
    expect(validateBrowserDeviceProfile(DEFAULT_BROWSER_DEVICE_PROFILE)).toBe(
      DEFAULT_BROWSER_DEVICE_PROFILE,
    );
    expect(DEFAULT_BROWSER_DEVICE_PROFILE).toMatchInlineSnapshot(`
      {
        "acceptLanguage": "en-US,en;q=0.9",
        "arch": "arm",
        "bitness": "64",
        "chrome": {
          "fullVersion": "150.0.7871.112",
          "major": 150,
        },
        "deviceMemoryGiB": 16,
        "dnt": false,
        "formFactors": [
          "Desktop",
        ],
        "hardwareConcurrency": 8,
        "id": "cd8398cf-96a0-4ba5-ab62-2823f9fd4289",
        "impersonateProfile": "chrome150",
        "installationId": "8d570359-34ed-4e1e-a164-25eb733c120e",
        "languages": [
          "en-US",
          "en",
        ],
        "maxTouchPoints": 0,
        "mobile": false,
        "model": "",
        "navigatorPlatform": "MacIntel",
        "oaiLanguage": "en-US",
        "platform": "macOS",
        "platformVersion": "14.7.5",
        "prefersColorScheme": "light",
        "prefersReducedMotion": "no-preference",
        "schemaVersion": 1,
        "screen": {
          "availHeight": 1415,
          "availWidth": 2560,
          "colorDepth": 24,
          "dpr": 2,
          "height": 1440,
          "width": 2560,
        },
        "secChUa": ""Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"",
        "secChUaFullVersionList": ""Not;A=Brand";v="8.0.0.0", "Chromium";v="150.0.7871.112", "Google Chrome";v="150.0.7871.112"",
        "seed": "aihub-fallback-browser-profile-v2-5",
        "timezone": {
          "iana": "America/Chicago",
          "jsDateSuffix": "GMT-0600 (Central Standard Time)",
          "offsetKind": "standard",
          "offsetMinutes": 360,
        },
        "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        "vendor": "Google Inc.",
        "webglRenderer": "ANGLE (Apple, Apple M3, OpenGL 4.1)",
        "webglVendor": "Apple Inc.",
        "wow64": false,
      }
    `);
  });

  it('carries neither a synthetic creation date nor a capped device-memory field', () => {
    // A date that is neither the creation time nor a fingerprint input is a trap, and
    // Chrome does not cap `Device-Memory` (capture: 32 on a 32 GiB machine).
    expect(DEFAULT_BROWSER_DEVICE_PROFILE).not.toHaveProperty('createdAt');
    expect(DEFAULT_BROWSER_DEVICE_PROFILE).not.toHaveProperty('deviceMemoryHeaderGiB');
  });

  it('pools only screens whose logical size times the DPR is a real panel', () => {
    for (let index = 0; index < 300; index += 1) {
      const { screen } = generateBrowserDeviceProfile({ seed: `panel-${index}` });
      expect(isPhysicallyPlausibleScreen(screen)).toBe(true);
    }

    // 3840x1080 logical @2 would need a 7680x2160 panel.
    expect(
      isPhysicallyPlausibleScreen({
        availHeight: 1040,
        availWidth: 3840,
        colorDepth: 24,
        dpr: 2,
        height: 1080,
        width: 3840,
      }),
    ).toBe(false);
  });

  it('rejects a profile whose screen and DPR imply a panel nobody can buy', () => {
    const profile = generateBrowserDeviceProfile({ seed: 'panel-guard' });

    expect(() =>
      validateBrowserDeviceProfile({
        ...profile,
        screen: { ...profile.screen, dpr: profile.screen.dpr === 1 ? 1.25 : 1 },
      }),
    ).toThrow(/screen/);
  });
});

describe('browser profile installation identity helpers', () => {
  const installationId = '123e4567-e89b-42d3-a456-426614174000';

  it('derives the Grok agent id as UUIDv5 over the shared installation id', () => {
    expect(deriveGrokAgentId(installationId)).toBe('af69a3c6-7f69-56df-b592-e6cf9fdca2b2');
    expect(() => deriveGrokAgentId('123e4567-e89b-52d3-a456-426614174000')).toThrow(
      /installationId must be a UUIDv4/,
    );
  });

  it('derives stable machine ids with required purpose separation', () => {
    expect(deriveStableMachineId(installationId, 'grok')).toBe(
      'a32df500298178395acd91677ced86d3f2c06c9d9c8d651d872d1a94347d11c1',
    );
    expect(deriveStableMachineId(installationId, 'grok')).toBe(
      deriveStableMachineId(installationId, 'grok'),
    );
    expect(deriveStableMachineId(installationId, 'cursor')).toBe(
      '8d81358a12a7b114e1061d202f865d0f2a39dabc0fd33457b348c8c82a79f4c2',
    );
    expect(deriveStableMachineId(installationId, 'cursor')).not.toBe(
      deriveStableMachineId(installationId, 'grok'),
    );
    expect(() => deriveStableMachineId(installationId, '')).toThrow(/purpose/);
  });

  it('derives deterministic UUIDv7-shaped conversation ids', () => {
    expect(deriveConversationSessionId('conv-a', 1_700_000_000_123)).toBe(
      '018bcfe5-687b-7f90-b3a7-86e261aa8314',
    );
    expect(deriveConversationSessionId('conv-a', 1_700_000_000_123)).toBe(
      deriveConversationSessionId('conv-a', 1_700_000_000_123),
    );
    expect(deriveConversationSessionId('conv-b', 1_700_000_000_123)).not.toBe(
      deriveConversationSessionId('conv-a', 1_700_000_000_123),
    );
    expect(() => deriveConversationSessionId('', 1_700_000_000_123)).toThrow(/key/);
  });

  it('carries the first-seen time in the 48 high bits, so two conversations differ', () => {
    const early = Date.UTC(2026, 7, 18, 3, 0, 0);
    const later = early + 90_000;
    const prefix = (id: string) => id.replaceAll('-', '').slice(0, 12);

    expect(Number.parseInt(prefix(deriveConversationSessionId('conv-a', early)), 16)).toBe(early);
    expect(prefix(deriveConversationSessionId('conv-a', early))).not.toBe(
      prefix(deriveConversationSessionId('conv-b', later)),
    );
  });

  it('derives a deterministic UUIDv4-shaped Cursor chat id per installation + conversation', () => {
    const installationA = '123e4567-e89b-42d3-a456-426614174000';
    const installationB = '123e4567-e89b-42d3-a456-426614174001';
    const id = deriveCursorConversationId(installationA, 'user:u1:topic:t1');

    expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(deriveCursorConversationId(installationA, 'user:u1:topic:t1')).toBe(id);
    expect(deriveCursorConversationId(installationA, 'user:u1:topic:t2')).not.toBe(id);
    expect(deriveCursorConversationId(installationB, 'user:u1:topic:t1')).not.toBe(id);
    expect(deriveCursorConversationId(installationA, 'user:u1:topic:t1').toLowerCase()).toBe(
      deriveCursorConversationId(installationA.toUpperCase(), 'user:u1:topic:t1'),
    );
    expect(() => deriveCursorConversationId('not-a-uuid', 'k')).toThrow(
      /installationId must be a UUIDv4/,
    );
    expect(() => deriveUuidV4FromName('')).toThrow(/must not be empty/);
  });
});

/**
 * Independent re-implementation of Chromium's `GenerateBrandVersionList`, which ASSIGNS
 * positions (`list[order[k]] = brand`) instead of indexing a source list with the
 * permutation.
 */
const GREASE_VERSIONS = ['8', '99', '24'];

const chromiumBrandList = (major: number, version: (brand: string) => string): string => {
  const greasyCharacters = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const greaseBrand = `Not${greasyCharacters[major % 11]}A${greasyCharacters[(major + 1) % 11]}Brand`;
  const order = orders[major % orders.length];
  const list: string[] = [];
  list[order[0]] = `"${greaseBrand}";v="${version(greaseBrand)}"`;
  list[order[1]] = `"Chromium";v="${version('Chromium')}"`;
  list[order[2]] = `"Google Chrome";v="${version('Google Chrome')}"`;
  return list.join(', ');
};

describe('deriveChromiumBrandHeaders', () => {
  it.each([
    // Captured from the pinned curl-impersonate binary (see the capture test below).
    [136, '136.0.7103.113', '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"'],
    [142, '142.0.7444.134', '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"'],
    [145, '145.0.7632.76', '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"'],
    [146, '146.0.7680.31', '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"'],
    [150, '150.0.7871.149', '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"'],
    [151, '151.0.7910.0', '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"'],
  ])('matches the captured Chromium %i data point', (major, fullVersion, expected) => {
    const result = deriveChromiumBrandHeaders(major, fullVersion);

    expect(result.secChUa).toBe(expected);
    expect(result.secChUaFullVersionList).toContain(`"Chromium";v="${fullVersion}"`);
    expect(result.secChUaFullVersionList).toContain(`"Google Chrome";v="${fullVersion}"`);
  });

  it('assigns brand positions the way Chromium does, for every major', () => {
    for (let major = 120; major <= 160; major += 1) {
      const fullVersion = `${major}.0.1.2`;
      const { secChUa, secChUaFullVersionList } = deriveChromiumBrandHeaders(major, fullVersion);

      expect(secChUa).toBe(
        chromiumBrandList(major, (brand) =>
          brand.startsWith('Not') ? GREASE_VERSIONS[major % 3] : String(major),
        ),
      );
      expect(secChUaFullVersionList).toBe(
        chromiumBrandList(major, (brand) =>
          brand.startsWith('Not') ? `${GREASE_VERSIONS[major % 3]}.0.0.0` : fullVersion,
        ),
      );
    }
  });
});

/**
 * Ground truth: the pinned curl-impersonate binary embeds the real Chrome header
 * templates, so its native `sec-ch-ua` for each pooled target is what that Chrome sends.
 * Skipped where the binary is not vendored (CI images without `.cache/`).
 */
const findCurlImpersonate = (): string | undefined => {
  const fromEnvironment = process.env.CHATGPT_WEB_CURL_IMPERSONATE_BIN;
  if (fromEnvironment && existsSync(fromEnvironment)) return fromEnvironment;

  let directory = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(directory, '.cache', 'curl-impersonate', 'curl-impersonate');
    if (existsSync(candidate)) return candidate;
    directory = path.dirname(directory);
  }
  return undefined;
};

const CURL_IMPERSONATE_BIN = findCurlImpersonate();

describe.skipIf(!CURL_IMPERSONATE_BIN)('pinned curl-impersonate captures', () => {
  it(
    'derives the native sec-ch-ua of every pooled Chrome major',
    async () => {
      const captured: Record<string, string | undefined> = {};
      const server = createServer((request, response) => {
        captured[request.url ?? ''] = request.headers['sec-ch-ua'] as string | undefined;
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;

      try {
        for (const { id, fullVersions, major } of IMPERSONATE_CHROME_PROFILES) {
          await new Promise<void>((resolve, reject) => {
            execFile(
              CURL_IMPERSONATE_BIN!,
              ['--impersonate', id, '-s', '-o', '/dev/null', `http://127.0.0.1:${port}/${id}`],
              (error) => (error ? reject(error) : resolve()),
            );
          });

          expect(captured[`/${id}`]).toBe(
            deriveChromiumBrandHeaders(major, fullVersions[0]).secChUa,
          );
        }
      } finally {
        server.close();
      }
    },
    { timeout: 60_000 },
  );
});
