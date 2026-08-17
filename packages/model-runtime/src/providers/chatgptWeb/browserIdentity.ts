import type { RuntimeBrowserDeviceProfile } from '../../browserProfile';
import { DEFAULT_BROWSER_DEVICE_PROFILE } from '../../browserProfile';

/** ChatGPT Web's compatibility view over the shared browser profile. */
export interface ChatGPTWebBrowserIdentity {
  acceptLanguage: string;
  chromeFullVersion: string;
  chromeMajor: string;
  device: {
    deviceMemoryGiB: number;
    dpr: number;
    hardwareConcurrency: number;
    screenHeight: number;
    screenWidth: number;
    timezone: string;
    timezoneOffsetMin: number;
  };
  dnt: boolean;
  impersonateProfile: RuntimeBrowserDeviceProfile['impersonateProfile'];
  navigatorLanguage: string;
  navigatorLanguages: string;
  secChUa: string;
  secChUaFullVersionList: string;
  userAgent: string;
}

/** Thin adapter retained for the public `chatgptWebIdentity` subpath. */
export const identityFromProfile = (
  profile: RuntimeBrowserDeviceProfile = DEFAULT_BROWSER_DEVICE_PROFILE,
): ChatGPTWebBrowserIdentity => ({
  acceptLanguage: profile.acceptLanguage,
  chromeFullVersion: profile.chrome.fullVersion,
  chromeMajor: String(profile.chrome.major),
  device: {
    deviceMemoryGiB: profile.deviceMemoryGiB,
    dpr: profile.screen.dpr,
    hardwareConcurrency: profile.hardwareConcurrency,
    screenHeight: profile.screen.height,
    screenWidth: profile.screen.width,
    timezone: profile.timezone.iana,
    timezoneOffsetMin: profile.timezone.offsetMinutes,
  },
  dnt: profile.dnt,
  impersonateProfile: profile.impersonateProfile,
  navigatorLanguage: profile.languages[0] ?? profile.oaiLanguage,
  navigatorLanguages: profile.languages.join(','),
  secChUa: profile.secChUa,
  secChUaFullVersionList: profile.secChUaFullVersionList,
  userAgent: profile.userAgent,
});

export const DEFAULT_CHATGPT_WEB_BROWSER_IDENTITY = identityFromProfile();
