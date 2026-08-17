/**
 * The persisted profile shape lives in `@lobechat/types` so the database schema,
 * this generator and the admin contracts cannot drift apart (type-only import:
 * the isomorphic `browserProfile` subpath keeps zero runtime dependencies).
 */
import type { BrowserDeviceProfile, BrowserPlatform } from '@lobechat/types';

export type {
  BrowserArchitecture,
  BrowserColorScheme,
  BrowserDeviceProfile,
  BrowserPlatform,
  BrowserReducedMotion,
  BrowserScreenProfile,
  BrowserTimezoneProfile,
  ImpersonateChromeProfileId,
} from '@lobechat/types';

/**
 * The runtime-facing view of a profile: everything except the private generator seed,
 * which reconstructs the whole identity and is never needed to send a request. Injection
 * seams strip it, so it cannot reach a runtime params dump.
 */
export type RuntimeBrowserDeviceProfile = Omit<BrowserDeviceProfile, 'seed'>;

export interface BrowserProfilePreferences {
  /** BCP-47 language tag used to bias, never force, locale selection. */
  localeHint?: string;
  /** Optional platform bias for callers with an explicit deployment preference. */
  platformHint?: BrowserPlatform;
}

export interface BrowserClientHintOptions {
  /**
   * `low` = the trio every Chrome sends unconditionally.
   * `high` = the full set, which Chrome only sends to an origin that delegated
   * the hints through `Accept-CH`. See `headers.ts`.
   */
  entropy: 'high' | 'low';
}

export type BrowserFetchMetadataKind = 'cors-put' | 'image' | 'navigate' | 'xhr';
