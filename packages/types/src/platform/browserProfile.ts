/**
 * Installation-wide synthetic browser device profile (JSON payload).
 *
 * Single source of truth for the shape that is persisted in
 * `platform_browser_profiles.profile`, generated and validated by
 * `@lobechat/model-runtime/browserProfile`, and summarized by the admin API.
 * Keep it dependency-free: the database schema, the model runtime and the
 * server contracts all import it from here.
 */

export type BrowserArchitecture = 'arm' | 'x86';

export type BrowserColorScheme = 'dark' | 'light';

export type BrowserPlatform = 'macOS' | 'Windows';

export type BrowserReducedMotion = 'no-preference' | 'reduce';

/** curl-impersonate targets compiled into the pinned binary. */
export const IMPERSONATE_CHROME_PROFILE_IDS = [
  'chrome136',
  'chrome142',
  'chrome145',
  'chrome146',
  'chrome150',
] as const;

export type ImpersonateChromeProfileId = (typeof IMPERSONATE_CHROME_PROFILE_IDS)[number];

export interface BrowserScreenProfile {
  /** Available logical CSS pixels after the operating-system chrome is reserved. */
  availHeight: number;
  availWidth: number;
  colorDepth: number;
  /** `window.devicePixelRatio`. */
  dpr: number;
  /** Logical CSS pixels reported by `window.screen`. */
  height: number;
  width: number;
}

export interface BrowserTimezoneProfile {
  /** IANA timezone name exposed by `Intl.DateTimeFormat().resolvedOptions()`. */
  iana: string;
  /**
   * Chrome `Date#toString()` tail in STANDARD time, for example
   * `GMT+0800 (China Standard Time)`. Only a fallback: request-time payloads
   * recompute the live (DST-aware) value from {@link BrowserTimezoneProfile.iana}.
   */
  jsDateSuffix: string;
  /** The stored offset is the zone's standard offset, never a live DST offset. */
  offsetKind: 'standard';
  /** `Date#getTimezoneOffset()` sign convention: minutes west of UTC. */
  offsetMinutes: number;
}

/**
 * A coherent, synthetic desktop Chrome installation.
 *
 * The object is JSON-serializable and is shared by every browser-impersonating
 * transport in one installation. `schemaVersion` must be bumped before changing
 * stored semantics.
 */
export interface BrowserDeviceProfile {
  acceptLanguage: string;
  arch: BrowserArchitecture;
  bitness: '64';
  chrome: {
    fullVersion: string;
    major: number;
  };
  /** Physical memory reported by `navigator.deviceMemory` style payloads. */
  deviceMemoryGiB: number;
  dnt: boolean;
  formFactors: ['Desktop'];
  hardwareConcurrency: number;
  id: string;
  impersonateProfile: ImpersonateChromeProfileId;
  /** Installation-wide UUID used by upstream device identity derivations. */
  installationId: string;
  languages: string[];
  maxTouchPoints: 0;
  mobile: false;
  model: '';
  /** `navigator.platform`, retained for proof-of-work style browser payloads. */
  navigatorPlatform: 'MacIntel' | 'Win32';
  oaiLanguage: string;
  platform: BrowserPlatform;
  /** Unquoted `sec-ch-ua-platform-version` value. */
  platformVersion: string;
  prefersColorScheme: BrowserColorScheme;
  prefersReducedMotion: BrowserReducedMotion;
  schemaVersion: 1;
  screen: BrowserScreenProfile;
  secChUa: string;
  secChUaFullVersionList: string;
  seed: string;
  timezone: BrowserTimezoneProfile;
  userAgent: string;
  vendor: 'Google Inc.';
  webglRenderer?: string;
  webglVendor?: string;
  wow64: false;
}
