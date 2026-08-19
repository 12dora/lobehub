export type { BrowserSessionRegistryOptions } from './contextRegistry';
export {
  createBrowserSessionRegistry,
  getBrowserSessionProviderState,
  getBrowserSessionRegistry,
  resetBrowserSessionRegistryForTests,
  setBrowserSessionProviderState,
  summarizeBrowserSessionContext,
} from './contextRegistry';
export type {
  ApplySetCookieOptions,
  CookieJarInspection,
  CookieRecord,
  CookieSeed,
  ReplaceCookieFamilyParams,
  SeedBrowserCookieJarOptions,
} from './cookieJar';
export {
  applySetCookieToBrowserCookieJar,
  cookieFamilyName,
  createBrowserCookieJar,
  DEFAULT_BROWSER_COOKIE_JAR_DIR_NAME,
  deleteBrowserCookieJar,
  ensureBrowserCookieJarFile,
  inspectBrowserCookieJar,
  isAllowedCookieName,
  isCookieFamilyMember,
  isSafeCookieSeed,
  purgeExpiredBrowserCookies,
  readBrowserCookieJar,
  replaceBrowserCookieFamily,
  resetBrowserCookieJars,
  resolveBrowserCookieJarPath,
  seedBrowserCookieJar,
} from './cookieJar';
export {
  buildBrowserSessionBindingDigest,
  buildBrowserSessionLookupKey,
  digestBrowserSessionMaterial,
  normalizeBrowserSessionAcquireInput,
  normalizeBrowserSessionIdentity,
  normalizeBrowserSessionOrigin,
} from './identity';
export {
  createBrowserSessionOwnerLease,
  disposeBrowserSessionResources,
  isBrowserSessionActive,
  isBrowserSessionLeaseHeldBy,
  markBrowserSessionInvalidated,
  markBrowserSessionReleased,
} from './lifecycle';
export type { BrowserSessionTransportHandle, BrowserSessionTransportPool } from './transportPool';
export {
  buildBrowserSessionTransportPoolKey,
  createBrowserSessionTransportPool,
} from './transportPool';
export type {
  BrowserSessionAcquireInput,
  BrowserSessionContext,
  BrowserSessionContextSummary,
  BrowserSessionCookieJarRef,
  BrowserSessionLifecycleStatus,
  BrowserSessionOwnerLease,
  BrowserSessionProviderNamespaces,
  BrowserSessionProviderState,
  BrowserSessionRegistry,
} from './types';
export { BrowserSessionError } from './types';
