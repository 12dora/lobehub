import {
  buildChromeUserAgent,
  deriveChromiumBrandHeaders,
  IMPERSONATE_CHROME_PROFILES,
  isPhysicallyPlausibleScreen,
  validateBrowserDeviceProfile,
} from './generate';
import { isUuidV4 } from './identity';
import type {
  BrowserDeviceProfile,
  BrowserPlatform,
  BrowserScreenProfile,
  RuntimeBrowserDeviceProfile,
} from './types';

/**
 * Read-path validation for a profile that was persisted by an earlier release.
 *
 * Two different questions are kept apart:
 *
 * 1. **Is this a coherent Chrome installation?** — asserted HERE, on every read. These
 *    are facts of Chrome and of the desktop, not of any pool: a desktop Chrome is never
 *    `mobile`, its UA is the frozen string for its major, its client hints are the GREASE
 *    permutation Chromium derives for that major, its screen times its DPR is a panel that
 *    exists. A stored record that fails one of them describes a machine nobody has, so it
 *    is rejected and the caller regenerates — keeping it would present that impossible
 *    device upstream forever.
 * 2. **Is it still what we would generate TODAY?** — {@link isCoherentBrowserDeviceProfile},
 *    reporting drift only. Pools rot (a Chrome build is retired, a screen entry repaired)
 *    and an installation must keep the identity it has been using upstream instead of
 *    collapsing onto the shared bundled fallback the moment a pool is edited.
 */

const IMPERSONATE_IDS = new Set<string>(IMPERSONATE_CHROME_PROFILES.map(({ id }) => id));

/** `navigator.deviceMemory` is quantized by Chrome; nothing else is reportable. */
const DEVICE_MEMORY_VALUES = new Set([4, 8, 16, 24, 32, 36, 48, 64, 128]);
const MIN_CORES = 2;
const MAX_CORES = 64;
/** Every real zone is inside ±14 h; the extra hour absorbs historical oddities. */
const MAX_TIMEZONE_OFFSET_MINUTES = 15 * 60;

interface PlatformFacts {
  architectures: readonly string[];
  navigatorPlatform: BrowserDeviceProfile['navigatorPlatform'];
}

/** Immutable platform facts (NOT a pool): Windows Chrome never reports arm here. */
const PLATFORM_FACTS: Record<BrowserPlatform, PlatformFacts> = {
  Windows: { architectures: ['x86'], navigatorPlatform: 'Win32' },
  macOS: { architectures: ['arm', 'x86'], navigatorPlatform: 'MacIntel' },
};

const fail = (message: string): never => {
  throw new Error(`Malformed persisted browser device profile: ${message}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) fail(`${key} must be a non-empty string`);
  return value as string;
};

const positive = (record: Record<string, unknown>, key: string, label: string): number => {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    fail(`${label} must be a positive number`);
  return value as number;
};

const oneOf = (record: Record<string, unknown>, key: string, allowed: readonly string[]): void => {
  const value = record[key];
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`${key} is not a known value`);
};

/**
 * Throws when the payload is not shaped like a {@link BrowserDeviceProfile}, or when it
 * is shaped like one but describes an impossible browser. The private `seed` is optional
 * here: injection seams strip it before the runtime sees a profile, and the persistence
 * layer compares it against its own column separately.
 */
export const validateBrowserDeviceProfileShape = (value: unknown): RuntimeBrowserDeviceProfile => {
  if (!isRecord(value)) return fail('payload is not an object');
  if (value.schemaVersion !== 1) fail('unsupported schemaVersion');
  if (typeof value.id !== 'string' || !isUuidV4(value.id)) fail('id is not a UUIDv4');
  if (typeof value.installationId !== 'string' || !isUuidV4(value.installationId))
    fail('installationId is not a UUIDv4');
  if (value.seed !== undefined && (typeof value.seed !== 'string' || value.seed.length === 0))
    fail('seed must be a non-empty string when present');

  if (
    typeof value.impersonateProfile !== 'string' ||
    !IMPERSONATE_IDS.has(value.impersonateProfile)
  )
    fail('impersonateProfile is not a supported curl-impersonate target');

  const chrome = value.chrome;
  if (!isRecord(chrome)) return fail('chrome is not an object');
  const fullVersion = text(chrome, 'fullVersion');
  if (!Number.isInteger(chrome.major) || (chrome.major as number) <= 0)
    fail('chrome.major must be a positive integer');
  const major = chrome.major as number;
  if (!fullVersion.startsWith(`${major}.`))
    fail('chrome.fullVersion does not belong to chrome.major');

  for (const key of [
    'acceptLanguage',
    'oaiLanguage',
    'platformVersion',
    'secChUa',
    'secChUaFullVersionList',
    'userAgent',
    'vendor',
  ])
    text(value, key);

  oneOf(value, 'arch', ['arm', 'x86']);
  oneOf(value, 'platform', ['macOS', 'Windows']);
  oneOf(value, 'navigatorPlatform', ['MacIntel', 'Win32']);
  oneOf(value, 'prefersColorScheme', ['dark', 'light']);
  oneOf(value, 'prefersReducedMotion', ['no-preference', 'reduce']);

  const platform = value.platform as BrowserPlatform;
  const facts = PLATFORM_FACTS[platform];
  if (value.navigatorPlatform !== facts.navigatorPlatform)
    fail('navigator.platform does not match the platform');
  if (!facts.architectures.includes(value.arch as string))
    fail('architecture is impossible on this platform');
  if (value.userAgent !== buildChromeUserAgent(platform, major))
    fail('user agent does not match the platform and Chrome major');
  if (value.vendor !== 'Google Inc.') fail('navigator.vendor is not Chrome');

  /**
   * The GREASE brand list is a pure function of the major (order + fake brand) and the
   * full version. A record whose hints disagree with that derivation was either hand-edited
   * or written by a build with the reversed order bug, and it is recognisable upstream.
   */
  const expectedHints = deriveChromiumBrandHeaders(major, fullVersion);
  if (value.secChUa !== expectedHints.secChUa)
    fail('sec-ch-ua is not the Chromium brand list for this Chrome major');
  if (value.secChUaFullVersionList !== expectedHints.secChUaFullVersionList)
    fail('sec-ch-ua-full-version-list is not the Chromium brand list for this Chrome version');

  if (value.bitness !== '64') fail('bitness must be 64');
  if (value.mobile !== false) fail('mobile must be false on a desktop profile');
  if (value.model !== '') fail('model must be empty on a desktop profile');
  if (value.maxTouchPoints !== 0) fail('maxTouchPoints must be 0 on a desktop profile');
  if (value.wow64 !== false) fail('wow64 must be false');
  if (typeof value.dnt !== 'boolean') fail('dnt must be a boolean');
  if (
    !Array.isArray(value.languages) ||
    value.languages.length === 0 ||
    value.languages.some((tag) => typeof tag !== 'string' || tag.length === 0)
  )
    fail('languages must be a non-empty list of tags');
  if (
    !Array.isArray(value.formFactors) ||
    value.formFactors.length !== 1 ||
    value.formFactors[0] !== 'Desktop'
  )
    fail('formFactors must be exactly Desktop');

  const deviceMemory = positive(value, 'deviceMemoryGiB', 'deviceMemoryGiB');
  if (!DEVICE_MEMORY_VALUES.has(deviceMemory))
    fail('deviceMemoryGiB is not a value a browser reports');
  const cores = positive(value, 'hardwareConcurrency', 'hardwareConcurrency');
  if (!Number.isInteger(cores) || cores < MIN_CORES || cores > MAX_CORES)
    fail('hardwareConcurrency is outside the range a desktop reports');

  const screen = value.screen;
  if (!isRecord(screen)) return fail('screen is not an object');
  for (const key of ['availHeight', 'availWidth', 'colorDepth', 'dpr', 'height', 'width'])
    positive(screen, key, `screen.${key}`);
  const screenProfile = screen as unknown as BrowserScreenProfile;
  if (
    screenProfile.availWidth > screenProfile.width ||
    screenProfile.availHeight > screenProfile.height
  )
    fail('screen available area is larger than the screen');
  if (!isPhysicallyPlausibleScreen(screenProfile))
    fail('screen size times DPR is not a real panel');

  const timezone = value.timezone;
  if (!isRecord(timezone)) return fail('timezone is not an object');
  text(timezone, 'iana');
  text(timezone, 'jsDateSuffix');
  if (timezone.offsetKind !== 'standard')
    fail('timezone.offsetKind must be the zone standard offset');
  if (
    typeof timezone.offsetMinutes !== 'number' ||
    !Number.isFinite(timezone.offsetMinutes) ||
    Math.abs(timezone.offsetMinutes) > MAX_TIMEZONE_OFFSET_MINUTES
  )
    fail('timezone.offsetMinutes is not a real offset');

  return value as unknown as RuntimeBrowserDeviceProfile;
};

/**
 * `true` when the profile also satisfies today's pools. A stored profile that is merely
 * incoherent with the current pools stays in use — this only reports the drift.
 */
export const isCoherentBrowserDeviceProfile = (profile: BrowserDeviceProfile): boolean => {
  try {
    validateBrowserDeviceProfile(profile);
    return true;
  } catch {
    return false;
  }
};
