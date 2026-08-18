import {
  buildChromeUserAgent,
  deriveChromiumBrandHeaders,
  IMPERSONATE_CHROME_PROFILES,
  LOCALE_BUNDLES,
  PLATFORM_DEFINITIONS,
  type PlatformDefinition,
  validateBrowserDeviceProfile,
} from './generate';
import type {
  BrowserArchitecture,
  BrowserDeviceProfile,
  BrowserPlatform,
  ImpersonateChromeProfileId,
} from './types';

/**
 * The definitions are declared `as const`, so each entry's architecture maps carry only the keys
 * that platform actually has — Windows has no `arm`. Reading them through the declared interface
 * is what the generator itself already does; indexing the raw literal union by the architecture
 * type is an implicit `any` on the narrower half.
 */
const PLATFORMS = PLATFORM_DEFINITIONS as readonly PlatformDefinition[];

export type BrowserProfileOptionErrorCode = 'INCOMPATIBLE_OPTIONS' | 'UNKNOWN_OPTION';

export class BrowserProfileOptionError extends Error {
  readonly code: BrowserProfileOptionErrorCode;

  constructor(code: BrowserProfileOptionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'BrowserProfileOptionError';
  }
}

export interface BrowserProfileChromeOption {
  fullVersion: string;
  id: string;
  impersonateProfile: ImpersonateChromeProfileId;
  label: string;
  major: number;
}

export interface BrowserProfileSystemOption {
  arch: BrowserArchitecture;
  id: string;
  label: string;
  navigatorPlatform: BrowserDeviceProfile['navigatorPlatform'];
  platform: BrowserPlatform;
  platformVersion: string;
}

export interface BrowserProfileLocaleOption {
  acceptLanguage: string;
  id: string;
  label: string;
  timezone: string;
}

export interface BrowserProfileScreenOption {
  dpr: number;
  height: number;
  id: string;
  label: string;
  platform: BrowserPlatform;
  width: number;
}

export interface BrowserProfileComputeOption {
  arch: BrowserArchitecture;
  cores: number;
  id: string;
  label: string;
  memoryGiB: number;
  platform: BrowserPlatform;
}

export interface BrowserProfileWebglOption {
  arch: BrowserArchitecture;
  id: string;
  label: string;
  platform: BrowserPlatform;
  renderer: string;
  vendor: string;
}

export interface BrowserProfileOptions {
  chrome: BrowserProfileChromeOption[];
  compute: BrowserProfileComputeOption[];
  locales: BrowserProfileLocaleOption[];
  screens: BrowserProfileScreenOption[];
  systems: BrowserProfileSystemOption[];
  webgl: BrowserProfileWebglOption[];
}

export interface BrowserProfileOptionIds {
  chromeId: string | null;
  computeId: string | null;
  localeId: string | null;
  screenId: string | null;
  systemId: string | null;
  webglId: string | null;
}

export interface BrowserProfileOptionSelection {
  chromeId: string;
  computeId: string;
  localeId: string;
  screenId: string;
  systemId: string;
  webglId: string;
}

export interface BrowserProfileComposeIdentity {
  dnt: boolean;
  id: string;
  installationId: string;
  prefersColorScheme: BrowserDeviceProfile['prefersColorScheme'];
  prefersReducedMotion: BrowserDeviceProfile['prefersReducedMotion'];
  seed: string;
}

const slugPart = (value: number | string): string =>
  String(value)
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');

/** Content-derived option id. Stable under pool reorder; never a positional index. */
export const browserProfileOptionId = (...parts: Array<number | string>): string =>
  parts.map(slugPart).filter(Boolean).join('--');

const formatDpr = (dpr: number): string => (Number.isInteger(dpr) ? String(dpr) : String(dpr));

const windowsMarketingName = (platformVersion: string): string => {
  const major = Number.parseInt(platformVersion.split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= 13 ? 'Windows 11' : 'Windows 10';
};

const systemLabel = (
  platform: BrowserPlatform,
  platformVersion: string,
  arch: BrowserArchitecture,
): string => {
  if (platform === 'macOS') {
    const chip = arch === 'arm' ? 'Apple Silicon' : 'Intel';
    return `macOS ${platformVersion} · ${chip}`;
  }
  return `${windowsMarketingName(platformVersion)} · ${platformVersion}`;
};

const webglLabel = (renderer: string): string => {
  const inner = /^ANGLE \((.+)\)$/.exec(renderer)?.[1] ?? renderer;
  const withoutApi = inner
    .replace(/, OpenGL .+$/u, '')
    .replace(/ Direct3D11 vs_\d+_\d+ ps_\d+_\d+$/u, '');
  const name = withoutApi.split(', ').at(-1) ?? withoutApi;
  return name.replaceAll('(R)', '').replaceAll('(TM)', '').replaceAll(/\s+/gu, ' ').trim();
};

const chromeOptions = (): BrowserProfileChromeOption[] =>
  IMPERSONATE_CHROME_PROFILES.map((profile) => {
    const fullVersion = profile.fullVersions.at(-1);
    if (!fullVersion) throw new Error('Chrome impersonate profile is missing fullVersions');
    return {
      fullVersion,
      id: browserProfileOptionId(profile.id),
      impersonateProfile: profile.id,
      label: `Chrome ${profile.major}`,
      major: profile.major,
    };
  });

const systemOptions = (): BrowserProfileSystemOption[] =>
  PLATFORMS.flatMap((definition) =>
    definition.architectures.flatMap(({ value: arch }) =>
      definition.platformVersions.map((platformVersion) => ({
        arch,
        id: browserProfileOptionId(definition.platform, platformVersion, arch),
        label: systemLabel(definition.platform, platformVersion, arch),
        navigatorPlatform: definition.navigatorPlatform,
        platform: definition.platform,
        platformVersion,
      })),
    ),
  );

const localeOptions = (): BrowserProfileLocaleOption[] =>
  LOCALE_BUNDLES.map((bundle) => ({
    acceptLanguage: bundle.acceptLanguage,
    id: browserProfileOptionId(bundle.acceptLanguage, bundle.timezone.iana),
    label: `${bundle.oaiLanguage} · ${bundle.timezone.iana}`,
    timezone: bundle.timezone.iana,
  }));

const screenOptions = (): BrowserProfileScreenOption[] =>
  PLATFORMS.flatMap((definition) =>
    definition.screens.map((screen) => ({
      dpr: screen.dpr,
      height: screen.height,
      id: browserProfileOptionId(definition.platform, screen.width, screen.height, screen.dpr),
      label: `${screen.width} × ${screen.height} @ ${formatDpr(screen.dpr)}×`,
      platform: definition.platform,
      width: screen.width,
    })),
  );

const computeOptions = (): BrowserProfileComputeOption[] =>
  PLATFORMS.flatMap((definition) =>
    definition.architectures.flatMap(({ value: arch }) => {
      const cores = definition.coresByArchitecture[arch] ?? [];
      const memories = definition.memoriesByArchitecture[arch] ?? [];
      return cores.flatMap((coreCount) =>
        memories.map((memoryGiB) => ({
          arch,
          cores: coreCount,
          id: browserProfileOptionId(definition.platform, arch, coreCount, memoryGiB),
          label: `${coreCount} cores · ${memoryGiB} GiB`,
          memoryGiB,
          platform: definition.platform,
        })),
      );
    }),
  );

const webglOptions = (): BrowserProfileWebglOption[] =>
  PLATFORMS.flatMap((definition) =>
    definition.webgl.flatMap((entry) =>
      entry.architectures.map((arch) => ({
        arch,
        id: browserProfileOptionId(definition.platform, arch, entry.vendor, entry.renderer),
        label: webglLabel(entry.renderer),
        platform: definition.platform,
        renderer: entry.renderer,
        vendor: entry.vendor,
      })),
    ),
  );

export const listBrowserProfileOptions = (): BrowserProfileOptions => ({
  chrome: chromeOptions(),
  compute: computeOptions(),
  locales: localeOptions(),
  screens: screenOptions(),
  systems: systemOptions(),
  webgl: webglOptions(),
});

const requireOption = <T extends { id: string }>(
  options: readonly T[],
  id: string,
  kind: string,
): T => {
  const option = options.find((item) => item.id === id);
  if (!option) throw new BrowserProfileOptionError('UNKNOWN_OPTION', `Unknown ${kind} option`);
  return option;
};

const findLocaleBundle = (option: BrowserProfileLocaleOption) => {
  const bundle = LOCALE_BUNDLES.find(
    (item) =>
      item.acceptLanguage === option.acceptLanguage && item.timezone.iana === option.timezone,
  );
  if (!bundle) {
    throw new BrowserProfileOptionError('UNKNOWN_OPTION', 'Unknown locale option');
  }
  return bundle;
};

const findScreenTuple = (option: BrowserProfileScreenOption) => {
  const platform = PLATFORMS.find((item) => item.platform === option.platform);
  const screen = platform?.screens.find(
    (item) =>
      item.width === option.width && item.height === option.height && item.dpr === option.dpr,
  );
  if (!screen) {
    throw new BrowserProfileOptionError('UNKNOWN_OPTION', 'Unknown screen option');
  }
  return { ...screen };
};

export const resolveBrowserProfileOptionIds = (
  profile: BrowserDeviceProfile,
): BrowserProfileOptionIds => {
  const options = listBrowserProfileOptions();
  const chrome = options.chrome.find(
    (item) => item.impersonateProfile === profile.impersonateProfile,
  );
  const system = options.systems.find(
    (item) =>
      item.platform === profile.platform &&
      item.platformVersion === profile.platformVersion &&
      item.arch === profile.arch,
  );
  const locale = options.locales.find(
    (item) =>
      item.acceptLanguage === profile.acceptLanguage && item.timezone === profile.timezone.iana,
  );
  const screen = options.screens.find(
    (item) =>
      item.platform === profile.platform &&
      item.width === profile.screen.width &&
      item.height === profile.screen.height &&
      item.dpr === profile.screen.dpr,
  );
  const compute = options.compute.find(
    (item) =>
      item.platform === profile.platform &&
      item.arch === profile.arch &&
      item.cores === profile.hardwareConcurrency &&
      item.memoryGiB === profile.deviceMemoryGiB,
  );
  const webgl = options.webgl.find(
    (item) =>
      item.platform === profile.platform &&
      item.arch === profile.arch &&
      item.vendor === profile.webglVendor &&
      item.renderer === profile.webglRenderer,
  );

  return {
    chromeId: chrome?.id ?? null,
    computeId: compute?.id ?? null,
    localeId: locale?.id ?? null,
    screenId: screen?.id ?? null,
    systemId: system?.id ?? null,
    webglId: webgl?.id ?? null,
  };
};

const resolveChromeFullVersion = (
  chrome: BrowserProfileChromeOption,
  existing?: Pick<BrowserDeviceProfile, 'chrome' | 'impersonateProfile'>,
): string => {
  const definition = IMPERSONATE_CHROME_PROFILES.find(
    (item) => item.id === chrome.impersonateProfile,
  );
  if (
    existing &&
    existing.impersonateProfile === chrome.impersonateProfile &&
    definition &&
    (definition.fullVersions as readonly string[]).includes(existing.chrome.fullVersion)
  ) {
    return existing.chrome.fullVersion;
  }
  return chrome.fullVersion;
};

export const composeBrowserDeviceProfileFromOptions = (
  selection: BrowserProfileOptionSelection,
  identity: BrowserProfileComposeIdentity,
  existing?: Pick<BrowserDeviceProfile, 'chrome' | 'impersonateProfile'>,
): BrowserDeviceProfile => {
  const options = listBrowserProfileOptions();
  const chrome = requireOption(options.chrome, selection.chromeId, 'chrome');
  const system = requireOption(options.systems, selection.systemId, 'system');
  const locale = requireOption(options.locales, selection.localeId, 'locale');
  const screen = requireOption(options.screens, selection.screenId, 'screen');
  const compute = requireOption(options.compute, selection.computeId, 'compute');
  const webgl = requireOption(options.webgl, selection.webglId, 'webgl');

  if (screen.platform !== system.platform) {
    throw new BrowserProfileOptionError(
      'INCOMPATIBLE_OPTIONS',
      'Screen option does not match the selected system platform',
    );
  }
  if (compute.platform !== system.platform || compute.arch !== system.arch) {
    throw new BrowserProfileOptionError(
      'INCOMPATIBLE_OPTIONS',
      'Compute option does not match the selected system platform or architecture',
    );
  }
  if (webgl.platform !== system.platform || webgl.arch !== system.arch) {
    throw new BrowserProfileOptionError(
      'INCOMPATIBLE_OPTIONS',
      'WebGL option does not match the selected system platform or architecture',
    );
  }

  const localeBundle = findLocaleBundle(locale);
  const fullVersion = resolveChromeFullVersion(chrome, existing);
  const hints = deriveChromiumBrandHeaders(chrome.major, fullVersion);
  const profile: BrowserDeviceProfile = {
    acceptLanguage: localeBundle.acceptLanguage,
    arch: system.arch,
    bitness: '64',
    chrome: { fullVersion, major: chrome.major },
    deviceMemoryGiB: compute.memoryGiB,
    dnt: identity.dnt,
    formFactors: ['Desktop'],
    hardwareConcurrency: compute.cores,
    id: identity.id,
    impersonateProfile: chrome.impersonateProfile,
    installationId: identity.installationId,
    languages: [...localeBundle.languages],
    maxTouchPoints: 0,
    mobile: false,
    model: '',
    navigatorPlatform: system.navigatorPlatform,
    oaiLanguage: localeBundle.oaiLanguage,
    platform: system.platform,
    platformVersion: system.platformVersion,
    prefersColorScheme: identity.prefersColorScheme,
    prefersReducedMotion: identity.prefersReducedMotion,
    schemaVersion: 1,
    screen: findScreenTuple(screen),
    secChUa: hints.secChUa,
    secChUaFullVersionList: hints.secChUaFullVersionList,
    seed: identity.seed,
    timezone: { ...localeBundle.timezone },
    userAgent: buildChromeUserAgent(system.platform, chrome.major),
    vendor: 'Google Inc.',
    webglRenderer: webgl.renderer,
    webglVendor: webgl.vendor,
    wow64: false,
  };

  return validateBrowserDeviceProfile(profile);
};

/**
 * Drive every catalog option through the strict write-path validator.
 * Used by tests so a pool edit cannot ship an unbuildable dropdown entry.
 */
export const sampleValidBrowserProfileCompositions = (): BrowserDeviceProfile[] => {
  const options = listBrowserProfileOptions();
  const identity = {
    dnt: false,
    id: '11111111-1111-4111-8111-111111111111',
    installationId: '22222222-2222-4222-8222-222222222222',
    prefersColorScheme: 'light' as const,
    prefersReducedMotion: 'no-preference' as const,
    seed: 'browser-profile-option-sample',
  };

  const byPlatformArch = (platform: BrowserPlatform, arch: BrowserArchitecture) => ({
    compute: options.compute.filter((item) => item.platform === platform && item.arch === arch),
    screens: options.screens.filter((item) => item.platform === platform),
    systems: options.systems.filter((item) => item.platform === platform && item.arch === arch),
    webgl: options.webgl.filter((item) => item.platform === platform && item.arch === arch),
  });

  const samples: BrowserDeviceProfile[] = [];
  const seenOptionKeys = new Set<string>();
  const record = (
    chrome: BrowserProfileChromeOption,
    system: BrowserProfileSystemOption,
    locale: BrowserProfileLocaleOption,
    screen: BrowserProfileScreenOption,
    compute: BrowserProfileComputeOption,
    webgl: BrowserProfileWebglOption,
  ) => {
    samples.push(
      composeBrowserDeviceProfileFromOptions(
        {
          chromeId: chrome.id,
          computeId: compute.id,
          localeId: locale.id,
          screenId: screen.id,
          systemId: system.id,
          webglId: webgl.id,
        },
        identity,
      ),
    );
    seenOptionKeys.add(`chrome:${chrome.id}`);
    seenOptionKeys.add(`system:${system.id}`);
    seenOptionKeys.add(`locale:${locale.id}`);
    seenOptionKeys.add(`screen:${screen.id}`);
    seenOptionKeys.add(`compute:${compute.id}`);
    seenOptionKeys.add(`webgl:${webgl.id}`);
  };

  const arches: Array<{ arch: BrowserArchitecture; platform: BrowserPlatform }> = [
    { arch: 'arm', platform: 'macOS' },
    { arch: 'x86', platform: 'macOS' },
    { arch: 'x86', platform: 'Windows' },
  ];

  for (const { platform, arch } of arches) {
    const group = byPlatformArch(platform, arch);
    const system = group.systems[0];
    const screen = group.screens[0];
    const compute = group.compute[0];
    const webgl = group.webgl[0];
    const locale = options.locales[0];
    if (!system || !screen || !compute || !webgl || !locale) {
      throw new Error(`Browser profile catalog has no ${platform}/${arch} baseline`);
    }

    for (const chrome of options.chrome) {
      record(chrome, system, locale, screen, compute, webgl);
    }
    for (const nextSystem of group.systems) {
      record(options.chrome[0]!, nextSystem, locale, screen, compute, webgl);
    }
    for (const nextLocale of options.locales) {
      record(options.chrome[0]!, system, nextLocale, screen, compute, webgl);
    }
    for (const nextScreen of group.screens) {
      record(options.chrome[0]!, system, locale, nextScreen, compute, webgl);
    }
    for (const nextCompute of group.compute) {
      record(options.chrome[0]!, system, locale, screen, nextCompute, webgl);
    }
    for (const nextWebgl of group.webgl) {
      record(options.chrome[0]!, system, locale, screen, compute, nextWebgl);
    }
  }

  const expected =
    options.chrome.length +
    options.systems.length +
    options.locales.length +
    options.screens.length +
    options.compute.length +
    options.webgl.length;
  if (seenOptionKeys.size !== expected) {
    throw new Error('Browser profile option sample missed a catalog entry');
  }

  return samples;
};
