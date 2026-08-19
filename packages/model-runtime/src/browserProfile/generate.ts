import { assertBrowserInstallationId, isUuidV4 } from './identity';
import type {
  BrowserArchitecture,
  BrowserDeviceProfile,
  BrowserPlatform,
  BrowserProfilePreferences,
  BrowserScreenProfile,
  BrowserTimezoneProfile,
  ImpersonateChromeProfileId,
} from './types';

export interface ImpersonateChromeProfileDefinition {
  fullVersions: readonly string[];
  id: ImpersonateChromeProfileId;
  major: number;
  weight: number;
}

/** Profiles compiled into the pinned curl-impersonate v2.1.0 binary. */
export const IMPERSONATE_CHROME_PROFILES = [
  {
    fullVersions: ['136.0.7103.92', '136.0.7103.113', '136.0.7103.114', '136.0.7103.116'],
    id: 'chrome136',
    major: 136,
    weight: 2,
  },
  {
    fullVersions: ['142.0.7444.59', '142.0.7444.134', '142.0.7444.175'],
    id: 'chrome142',
    major: 142,
    weight: 3,
  },
  {
    fullVersions: ['145.0.7632.68', '145.0.7632.76', '145.0.7632.110'],
    id: 'chrome145',
    major: 145,
    weight: 5,
  },
  {
    fullVersions: ['146.0.7680.31', '146.0.7680.56', '146.0.7680.74'],
    id: 'chrome146',
    major: 146,
    weight: 7,
  },
  {
    fullVersions: ['150.0.7871.95', '150.0.7871.112', '150.0.7871.149'],
    id: 'chrome150',
    major: 150,
    weight: 10,
  },
] as const satisfies readonly ImpersonateChromeProfileDefinition[];

export interface LocaleBundle {
  acceptLanguage: string;
  languages: readonly string[];
  oaiLanguage: string;
  timezone: BrowserTimezoneProfile;
  weight: number;
}

export const LOCALE_BUNDLES = [
  {
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    languages: ['zh-CN', 'zh', 'en'],
    oaiLanguage: 'zh-CN',
    timezone: {
      iana: 'Asia/Shanghai',
      jsDateSuffix: 'GMT+0800 (China Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: -480,
    },
    weight: 9,
  },
  {
    acceptLanguage: 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    languages: ['zh-CN', 'zh', 'en-US', 'en'],
    oaiLanguage: 'zh-CN',
    timezone: {
      iana: 'Asia/Hong_Kong',
      jsDateSuffix: 'GMT+0800 (Hong Kong Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: -480,
    },
    weight: 4,
  },
  {
    /**
     * Captured from the real Chrome session used by the ChatGPT Web shared
     * account on 2026-08-19. Keep it operator-selectable without changing the
     * deterministic distribution of already-generated installation profiles.
     */
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7,ja;q=0.6',
    languages: ['zh-CN', 'zh', 'en', 'zh-TW', 'ja'],
    oaiLanguage: 'zh-CN',
    timezone: {
      iana: 'Asia/Singapore',
      jsDateSuffix: 'GMT+0800 (新加坡标准时间)',
      offsetKind: 'standard',
      offsetMinutes: -480,
    },
    // Manual calibration target only; zero preserves seeded generation output.
    weight: 0,
  },
  {
    acceptLanguage: 'en-US,en;q=0.9',
    languages: ['en-US', 'en'],
    oaiLanguage: 'en-US',
    timezone: {
      iana: 'America/Los_Angeles',
      jsDateSuffix: 'GMT-0800 (Pacific Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: 480,
    },
    weight: 8,
  },
  {
    acceptLanguage: 'en-US,en;q=0.9',
    languages: ['en-US', 'en'],
    oaiLanguage: 'en-US',
    timezone: {
      iana: 'America/New_York',
      jsDateSuffix: 'GMT-0500 (Eastern Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: 300,
    },
    weight: 7,
  },
  {
    acceptLanguage: 'en-US,en;q=0.9',
    languages: ['en-US', 'en'],
    oaiLanguage: 'en-US',
    timezone: {
      iana: 'America/Chicago',
      jsDateSuffix: 'GMT-0600 (Central Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: 360,
    },
    weight: 4,
  },
  {
    acceptLanguage: 'en-GB,en;q=0.9',
    languages: ['en-GB', 'en'],
    oaiLanguage: 'en-GB',
    timezone: {
      iana: 'Europe/London',
      jsDateSuffix: 'GMT+0000 (Greenwich Mean Time)',
      offsetKind: 'standard',
      offsetMinutes: 0,
    },
    weight: 5,
  },
  {
    acceptLanguage: 'ja,en-US;q=0.9,en;q=0.8',
    languages: ['ja', 'en-US', 'en'],
    oaiLanguage: 'ja',
    timezone: {
      iana: 'Asia/Tokyo',
      jsDateSuffix: 'GMT+0900 (Japan Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: -540,
    },
    weight: 5,
  },
  {
    acceptLanguage: 'zh-TW,zh;q=0.9,en;q=0.8',
    languages: ['zh-TW', 'zh', 'en'],
    oaiLanguage: 'zh-TW',
    timezone: {
      iana: 'Asia/Taipei',
      jsDateSuffix: 'GMT+0800 (Taipei Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: -480,
    },
    weight: 4,
  },
  {
    acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8',
    languages: ['de-DE', 'de', 'en'],
    oaiLanguage: 'de-DE',
    timezone: {
      iana: 'Europe/Berlin',
      jsDateSuffix: 'GMT+0100 (Central European Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: -60,
    },
    weight: 3,
  },
  {
    acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.8',
    languages: ['fr-FR', 'fr', 'en'],
    oaiLanguage: 'fr-FR',
    timezone: {
      iana: 'Europe/Paris',
      jsDateSuffix: 'GMT+0100 (Central European Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: -60,
    },
    weight: 3,
  },
  {
    acceptLanguage: 'es-ES,es;q=0.9,en;q=0.8',
    languages: ['es-ES', 'es', 'en'],
    oaiLanguage: 'es-ES',
    timezone: {
      iana: 'Europe/Madrid',
      jsDateSuffix: 'GMT+0100 (Central European Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: -60,
    },
    weight: 2,
  },
  {
    acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.8',
    languages: ['pt-BR', 'pt', 'en'],
    oaiLanguage: 'pt-BR',
    timezone: {
      iana: 'America/Sao_Paulo',
      jsDateSuffix: 'GMT-0300 (Brasilia Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: 180,
    },
    weight: 2,
  },
  {
    acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8',
    languages: ['ko-KR', 'ko', 'en'],
    oaiLanguage: 'ko-KR',
    timezone: {
      iana: 'Asia/Seoul',
      jsDateSuffix: 'GMT+0900 (Korean Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: -540,
    },
    weight: 2,
  },
  {
    acceptLanguage: 'en-AU,en;q=0.9',
    languages: ['en-AU', 'en'],
    oaiLanguage: 'en-AU',
    timezone: {
      iana: 'Australia/Sydney',
      jsDateSuffix: 'GMT+1000 (Australian Eastern Standard Time)',
      offsetKind: 'standard',
      offsetMinutes: -600,
    },
    weight: 2,
  },
] as const satisfies readonly LocaleBundle[];

/**
 * Every IANA zone the generator can pick. The runtime asks `Intl` for each zone's live
 * offset and long name, so a deployment must ship FULL ICU data (Node's default build,
 * or `--with-intl=full-icu`): a small-ICU runtime silently falls back to the stored
 * standard-time pair, which contradicts the IANA name for half the year in half of these.
 * Guarded by `timezone.test.ts`, which resolves every entry on the running Node.
 */
export const BROWSER_PROFILE_TIMEZONE_POOL: readonly string[] = [
  ...new Set(LOCALE_BUNDLES.map((bundle) => bundle.timezone.iana)),
];

export interface PlatformDefinition {
  architectures: readonly { value: BrowserArchitecture; weight: number }[];
  coresByArchitecture: Partial<Record<BrowserArchitecture, readonly number[]>>;
  memoriesByArchitecture: Partial<Record<BrowserArchitecture, readonly number[]>>;
  navigatorPlatform: BrowserDeviceProfile['navigatorPlatform'];
  platform: BrowserPlatform;
  platformVersions: readonly string[];
  screens: readonly BrowserScreenProfile[];
  webgl: readonly {
    architectures: readonly BrowserArchitecture[];
    renderer: string;
    vendor: string;
  }[];
  weight: number;
}

const MAC_SCREENS = [
  { availHeight: 875, availWidth: 1440, colorDepth: 24, dpr: 2, height: 900, width: 1440 },
  { availHeight: 956, availWidth: 1512, colorDepth: 24, dpr: 2, height: 982, width: 1512 },
  { availHeight: 1091, availWidth: 1728, colorDepth: 24, dpr: 2, height: 1117, width: 1728 },
  { availHeight: 1055, availWidth: 1920, colorDepth: 24, dpr: 1, height: 1080, width: 1920 },
  { availHeight: 1415, availWidth: 2560, colorDepth: 24, dpr: 1, height: 1440, width: 2560 },
  { availHeight: 1415, availWidth: 2560, colorDepth: 24, dpr: 2, height: 1440, width: 2560 },
] as const satisfies readonly BrowserScreenProfile[];

/**
 * `width`/`height` are LOGICAL CSS pixels, so `width * dpr` must land on a panel that
 * exists (see {@link PHYSICAL_PANELS}). A scaled display is therefore expressed at its
 * scaled logical size — `1536x864 @1.25` IS a 1920x1080 panel at 125 % — never as a
 * native resolution paired with a scale factor.
 */
const WINDOWS_SCREENS = [
  { availHeight: 1040, availWidth: 1920, colorDepth: 24, dpr: 1, height: 1080, width: 1920 },
  { availHeight: 824, availWidth: 1536, colorDepth: 24, dpr: 1.25, height: 864, width: 1536 },
  { availHeight: 680, availWidth: 1280, colorDepth: 24, dpr: 1.5, height: 720, width: 1280 },
  { availHeight: 1400, availWidth: 2560, colorDepth: 24, dpr: 1, height: 1440, width: 2560 },
  { availHeight: 1112, availWidth: 2048, colorDepth: 24, dpr: 1.25, height: 1152, width: 2048 },
  { availHeight: 1400, availWidth: 2560, colorDepth: 24, dpr: 1.5, height: 1440, width: 2560 },
  { availHeight: 1688, availWidth: 3072, colorDepth: 24, dpr: 1.25, height: 1728, width: 3072 },
  { availHeight: 1040, availWidth: 1920, colorDepth: 24, dpr: 2, height: 1080, width: 1920 },
] as const satisfies readonly BrowserScreenProfile[];

/**
 * Physical panels the pooled logical/DPR pairs resolve to. A pool entry whose
 * `width * dpr` / `height * dpr` is not one of these describes a machine nobody can buy,
 * which pool membership alone could never catch.
 */
const PHYSICAL_PANELS = [
  [1920, 1080],
  [2560, 1440],
  [2560, 1600],
  [2880, 1800],
  [3024, 1964],
  [3456, 2234],
  [3840, 2160],
  [5120, 2880],
] as const;

/** Chrome rounds logical pixels, so a scaled panel is allowed to miss by a pixel. */
const PANEL_TOLERANCE_PX = 2;

/** `true` when the logical size times the DPR is a real panel. */
export const isPhysicallyPlausibleScreen = (screen: BrowserScreenProfile): boolean =>
  PHYSICAL_PANELS.some(
    ([panelWidth, panelHeight]) =>
      Math.abs(Math.round(screen.width * screen.dpr) - panelWidth) <= PANEL_TOLERANCE_PX &&
      Math.abs(Math.round(screen.height * screen.dpr) - panelHeight) <= PANEL_TOLERANCE_PX,
  );

export const PLATFORM_DEFINITIONS = [
  {
    architectures: [
      { value: 'arm', weight: 7 },
      { value: 'x86', weight: 3 },
    ],
    coresByArchitecture: {
      arm: [8, 10, 12, 14, 16],
      x86: [8, 10, 12, 16],
    },
    memoriesByArchitecture: {
      arm: [8, 16, 24, 32, 36, 64],
      x86: [8, 16, 32, 64],
    },
    navigatorPlatform: 'MacIntel',
    platform: 'macOS',
    platformVersions: ['13.6.9', '14.7.5', '15.4.1', '15.6.1'],
    screens: MAC_SCREENS,
    weight: 6,
    webgl: [
      {
        architectures: ['arm'],
        renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
        vendor: 'Apple Inc.',
      },
      {
        architectures: ['arm'],
        renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)',
        vendor: 'Apple Inc.',
      },
      {
        architectures: ['arm'],
        renderer: 'ANGLE (Apple, Apple M3, OpenGL 4.1)',
        vendor: 'Apple Inc.',
      },
      {
        architectures: ['x86'],
        renderer: 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics, OpenGL 4.1)',
        vendor: 'Intel Inc.',
      },
    ],
  },
  {
    architectures: [{ value: 'x86', weight: 1 }],
    coresByArchitecture: { x86: [4, 6, 8, 12, 16, 20, 24, 32] },
    memoriesByArchitecture: { x86: [8, 16, 32, 64] },
    navigatorPlatform: 'Win32',
    platform: 'Windows',
    platformVersions: ['10.0.0', '13.0.0', '15.0.0', '19.0.0'],
    screens: WINDOWS_SCREENS,
    weight: 4,
    webgl: [
      {
        architectures: ['x86'],
        renderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)',
        vendor: 'Google Inc. (Intel)',
      },
      {
        architectures: ['x86'],
        renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
        vendor: 'Google Inc. (NVIDIA)',
      },
      {
        architectures: ['x86'],
        renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0)',
        vendor: 'Google Inc. (AMD)',
      },
    ],
  },
] as const satisfies readonly PlatformDefinition[];

const GREASY_CHARACTERS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'] as const;
const GREASE_VERSIONS = ['8', '99', '24'] as const;
const BRAND_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

export interface ChromiumBrandHeaders {
  secChUa: string;
  secChUaFullVersionList: string;
}

/** Chromium's deterministic UA-CH GREASE brand derivation. */
export const deriveChromiumBrandHeaders = (
  major: number,
  fullVersion: string,
): ChromiumBrandHeaders => {
  const first = GREASY_CHARACTERS[major % GREASY_CHARACTERS.length];
  const second = GREASY_CHARACTERS[(major + 1) % GREASY_CHARACTERS.length];
  const greaseBrand = `Not${first}A${second}Brand`;
  const greaseVersion = GREASE_VERSIONS[major % GREASE_VERSIONS.length];
  const brands = [
    { brand: greaseBrand, fullVersion: `${greaseVersion}.0.0.0`, version: greaseVersion },
    { brand: 'Chromium', fullVersion, version: String(major) },
    { brand: 'Google Chrome', fullVersion, version: String(major) },
  ];

  /**
   * Chromium's `GenerateBrandVersionList` ASSIGNS positions — `list[order[0]] = grease`,
   * `list[order[1]] = chromium`, `list[order[2]] = brand` — it does not index a source
   * list with the permutation. Four of the six permutations are self-inverse, which is
   * why reading them the wrong way round still matched the 150/151 captures and only
   * broke `major % 6 ∈ {3, 4}` (chrome136/142 among the pooled targets).
   * Verified against the pinned curl-impersonate binary for 136/142/145/146/150.
   */
  const order = BRAND_ORDERS[major % BRAND_ORDERS.length];
  const ordered = [...brands];
  order.forEach((position, index) => {
    ordered[position] = brands[index];
  });
  return {
    secChUa: ordered.map(({ brand, version }) => `"${brand}";v="${version}"`).join(', '),
    secChUaFullVersionList: ordered
      .map(({ brand, fullVersion: version }) => `"${brand}";v="${version}"`)
      .join(', '),
  };
};

const xmur3 = (value: string): (() => number) => {
  let state = 1_779_033_703 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    state = Math.imul(state ^ value.charCodeAt(index), 3_432_918_353);
    state = (state << 13) | (state >>> 19);
  }
  return () => {
    state = Math.imul(state ^ (state >>> 16), 2_246_822_507);
    state = Math.imul(state ^ (state >>> 13), 3_266_489_909);
    return (state ^= state >>> 16) >>> 0;
  };
};

const createPrng = (seed: string): (() => number) => {
  const hash = xmur3(seed);
  let a = hash();
  let b = hash();
  let c = hash();
  let d = hash();
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const result = (a + b + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + result) | 0;
    return (result >>> 0) / 4_294_967_296;
  };
};

const pick = <T>(values: readonly T[], random: () => number): T => {
  if (values.length === 0) throw new Error('Browser profile pool must not be empty');
  const value = values[Math.min(values.length - 1, Math.floor(random() * values.length))];
  if (value === undefined) throw new Error('Browser profile pool selection failed');
  return value;
};

const pickWeighted = <T>(
  values: readonly T[],
  weightOf: (value: T) => number,
  random: () => number,
): T => {
  if (values.length === 0) throw new Error('Browser profile weighted pool must not be empty');
  const total = values.reduce((sum, value) => sum + weightOf(value), 0);
  let cursor = random() * total;
  for (const value of values) {
    cursor -= weightOf(value);
    if (cursor < 0) return value;
  }
  const fallback = values.at(-1);
  if (fallback === undefined) throw new Error('Browser profile weighted pool selection failed');
  return fallback;
};

const uuidFromRandom = (random: () => number): string => {
  const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Chrome's frozen ("reduced") User-Agent: only the platform token and the major version
 * vary. Exported so the read-path validator asserts the SAME string instead of a second
 * copy of the rule.
 */
export const buildChromeUserAgent = (platform: BrowserPlatform, major: number): string => {
  const osToken =
    platform === 'macOS' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64';
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
};

const localeWeight = (bundle: LocaleBundle, localeHint?: string): number => {
  if (!localeHint) return bundle.weight;
  const normalized = localeHint.toLowerCase();
  const language = normalized.split('-')[0];
  const exact = bundle.languages.some((tag) => tag.toLowerCase() === normalized);
  const family = bundle.languages.some((tag) => tag.toLowerCase().split('-')[0] === language);
  return bundle.weight * (exact ? 5 : family ? 3 : 1);
};

const platformWeight = (definition: PlatformDefinition, platformHint?: BrowserPlatform): number =>
  definition.weight * (definition.platform === platformHint ? 4 : 1);

export const generateBrowserDeviceProfile = ({
  preferences,
  seed,
}: {
  preferences?: BrowserProfilePreferences;
  seed: string;
}): BrowserDeviceProfile => {
  if (!seed) throw new Error('Browser profile seed must not be empty');

  const random = createPrng(`browser-device-profile:v1:${seed}`);
  const id = uuidFromRandom(random);
  const installationId = uuidFromRandom(createPrng(`browser-device-installation-id:v1:${seed}`));
  const chrome: ImpersonateChromeProfileDefinition = pickWeighted(
    IMPERSONATE_CHROME_PROFILES,
    (item) => item.weight,
    random,
  );
  const fullVersion = pick(chrome.fullVersions, random);
  const platform: PlatformDefinition = pickWeighted(
    PLATFORM_DEFINITIONS as readonly PlatformDefinition[],
    (item) => platformWeight(item, preferences?.platformHint),
    random,
  );
  const arch = pickWeighted(platform.architectures, (item) => item.weight, random).value;
  const locale: LocaleBundle = pickWeighted(
    LOCALE_BUNDLES as readonly LocaleBundle[],
    (item) => localeWeight(item, preferences?.localeHint),
    random,
  );
  const cores = platform.coresByArchitecture[arch];
  const memories = platform.memoriesByArchitecture[arch];
  if (!cores || !memories) throw new Error('Browser platform has no pool for its architecture');
  const memory = pick(memories, random);
  const compatibleWebgl = platform.webgl.filter((item) =>
    (item.architectures as readonly BrowserArchitecture[]).includes(arch),
  );
  const webgl = pick(compatibleWebgl, random);
  const hints = deriveChromiumBrandHeaders(chrome.major, fullVersion);

  const profile: BrowserDeviceProfile = {
    acceptLanguage: locale.acceptLanguage,
    arch,
    bitness: '64',
    chrome: { fullVersion, major: chrome.major },
    deviceMemoryGiB: memory,
    dnt: random() < 0.2,
    formFactors: ['Desktop'],
    hardwareConcurrency: pick(cores, random),
    id,
    installationId,
    impersonateProfile: chrome.id,
    languages: [...locale.languages],
    maxTouchPoints: 0,
    mobile: false,
    model: '',
    navigatorPlatform: platform.navigatorPlatform,
    oaiLanguage: locale.oaiLanguage,
    platform: platform.platform,
    platformVersion: pick(platform.platformVersions, random),
    prefersColorScheme: random() < 0.8 ? 'light' : 'dark',
    prefersReducedMotion: random() < 0.95 ? 'no-preference' : 'reduce',
    schemaVersion: 1,
    screen: { ...pick(platform.screens, random) },
    secChUa: hints.secChUa,
    secChUaFullVersionList: hints.secChUaFullVersionList,
    seed,
    timezone: { ...locale.timezone },
    userAgent: buildChromeUserAgent(platform.platform, chrome.major),
    vendor: 'Google Inc.',
    webglRenderer: webgl.renderer,
    webglVendor: webgl.vendor,
    wow64: false,
  };

  validateBrowserDeviceProfile(profile);
  return profile;
};

const fail = (message: string): never => {
  throw new Error(`Invalid browser device profile: ${message}`);
};

const sameScreen = (left: BrowserScreenProfile, right: BrowserScreenProfile): boolean =>
  left.availHeight === right.availHeight &&
  left.availWidth === right.availWidth &&
  left.colorDepth === right.colorDepth &&
  left.dpr === right.dpr &&
  left.height === right.height &&
  left.width === right.width;

export const validateBrowserDeviceProfile = (
  profile: BrowserDeviceProfile,
): BrowserDeviceProfile => {
  if (profile.schemaVersion !== 1) fail('unsupported schemaVersion');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profile.id))
    fail('id is not a UUIDv4');
  if (!isUuidV4(profile.installationId)) fail('installationId is not a UUIDv4');
  assertBrowserInstallationId(profile.installationId);
  if (!profile.seed) fail('seed is empty');

  const chrome = IMPERSONATE_CHROME_PROFILES.find((item) => item.id === profile.impersonateProfile);
  if (!chrome) return fail('impersonate profile is unsupported');
  if (profile.chrome.major !== chrome.major)
    fail('Chrome major does not match impersonate profile');
  if (!(chrome.fullVersions as readonly string[]).includes(profile.chrome.fullVersion))
    fail('Chrome full version is outside the impersonate profile pool');

  const expectedHints = deriveChromiumBrandHeaders(
    profile.chrome.major,
    profile.chrome.fullVersion,
  );
  if (profile.secChUa !== expectedHints.secChUa) fail('sec-ch-ua does not match Chrome major');
  if (profile.secChUaFullVersionList !== expectedHints.secChUaFullVersionList)
    fail('sec-ch-ua-full-version-list does not match Chrome full version');
  if (profile.userAgent !== buildChromeUserAgent(profile.platform, profile.chrome.major))
    fail('user agent does not match Chrome major or platform');

  const platform: PlatformDefinition | undefined = (
    PLATFORM_DEFINITIONS as readonly PlatformDefinition[]
  ).find((item) => item.platform === profile.platform);
  if (!platform) return fail('platform is unsupported');
  if (!platform.architectures.some((item) => item.value === profile.arch))
    fail('architecture does not match platform');
  if (profile.platform === 'Windows' && profile.arch !== 'x86')
    fail('Windows profile must use x86 architecture');
  if (!(platform.platformVersions as readonly string[]).includes(profile.platformVersion))
    fail('platform version is outside the platform pool');
  if (!platform.screens.some((screen) => sameScreen(screen, profile.screen)))
    fail('screen and DPR combination is outside the platform pool');
  if (!isPhysicallyPlausibleScreen(profile.screen))
    fail('screen size times DPR is not a real panel');
  const cores = platform.coresByArchitecture[profile.arch];
  const memories = platform.memoriesByArchitecture[profile.arch];
  if (!cores || !cores.includes(profile.hardwareConcurrency))
    fail('hardwareConcurrency is outside the platform pool');
  if (!memories || !memories.includes(profile.deviceMemoryGiB))
    fail('device memory is outside the platform pool');
  if (profile.navigatorPlatform !== platform.navigatorPlatform)
    fail('navigator.platform does not match platform');

  if (
    profile.bitness !== '64' ||
    profile.mobile !== false ||
    profile.model !== '' ||
    profile.wow64 !== false
  )
    fail('desktop high-entropy client hints are incoherent');
  if (profile.formFactors.length !== 1 || profile.formFactors[0] !== 'Desktop')
    fail('formFactors must contain Desktop');
  if (profile.maxTouchPoints !== 0 || profile.vendor !== 'Google Inc.')
    fail('desktop navigator facts are incoherent');

  const locale = LOCALE_BUNDLES.find(
    (item) =>
      item.acceptLanguage === profile.acceptLanguage &&
      item.timezone.iana === profile.timezone.iana,
  );
  if (!locale) return fail('locale and timezone are not a known coherent bundle');
  if (
    locale.oaiLanguage !== profile.oaiLanguage ||
    locale.languages.length !== profile.languages.length ||
    locale.languages.some((tag, index) => tag !== profile.languages[index]) ||
    locale.timezone.offsetMinutes !== profile.timezone.offsetMinutes ||
    locale.timezone.jsDateSuffix !== profile.timezone.jsDateSuffix ||
    profile.timezone.offsetKind !== 'standard'
  )
    fail('locale language or timezone fields disagree');
  if (!/^GMT[+-]\d{4} \(.+\)$/.test(profile.timezone.jsDateSuffix))
    fail('timezone Date suffix is invalid');

  if (!['dark', 'light'].includes(profile.prefersColorScheme))
    fail('prefersColorScheme is invalid');
  if (!['no-preference', 'reduce'].includes(profile.prefersReducedMotion))
    fail('prefersReducedMotion is invalid');
  if (typeof profile.dnt !== 'boolean') fail('dnt must be boolean');

  if (!!profile.webglVendor !== !!profile.webglRenderer)
    fail('WebGL vendor and renderer must be present together');
  if (
    profile.webglVendor &&
    !platform.webgl.some(
      (item) => item.vendor === profile.webglVendor && item.renderer === profile.webglRenderer,
    )
  )
    fail('WebGL vendor and renderer do not match platform');
  if (
    profile.webglVendor &&
    !platform.webgl.some(
      (item) =>
        item.vendor === profile.webglVendor &&
        item.renderer === profile.webglRenderer &&
        (item.architectures as readonly BrowserArchitecture[]).includes(profile.arch),
    )
  )
    fail('WebGL vendor and renderer do not match architecture');

  return profile;
};

/**
 * Seed of the bundled fallback identity.
 *
 * Fixed so that every degraded request (database unavailable, isomorphic callers) in every
 * installation presents the same stable, unremarkable desktop identity. It is a generated
 * profile like any other — nothing in it is copied from a real machine.
 */
export const DEFAULT_BROWSER_DEVICE_PROFILE_SEED = 'aihub-fallback-browser-profile-v2-5';

/** Stable, non-host-derived fallback for isomorphic and degraded operation. */
export const DEFAULT_BROWSER_DEVICE_PROFILE = generateBrowserDeviceProfile({
  seed: DEFAULT_BROWSER_DEVICE_PROFILE_SEED,
});

/**
 * `true` for the bundled fallback identity — a degraded path (database unavailable) or a
 * caller that consciously passed it. State minted under the persisted identity must not
 * be replayed while presenting this one: cookie jars are keyed by connection, not by
 * profile, and `cf_clearance` is bound to the User-Agent that obtained it.
 */
export const isFallbackBrowserProfile = (profile: Pick<BrowserDeviceProfile, 'id'>): boolean =>
  profile.id === DEFAULT_BROWSER_DEVICE_PROFILE.id;
