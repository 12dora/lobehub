import type {
  BrowserClientHintOptions,
  BrowserFetchMetadataKind,
  RuntimeBrowserDeviceProfile,
} from './types';

export const ACCEPT_ANY = '*/*';
export const ACCEPT_JSON = 'application/json, text/plain, */*';
export const ACCEPT_IMAGE = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
export const ACCEPT_NAVIGATE =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

export const PRIORITY_CORS_PUT = 'u=1, i';
export const PRIORITY_IMAGE = 'u=1, i';
export const PRIORITY_NAVIGATE = 'u=0, i';
export const PRIORITY_XHR = 'u=1, i';

/** Profile-template headers that belong only to a document navigation. */
export const NAVIGATION_ONLY_HEADERS = ['Sec-Fetch-User', 'Upgrade-Insecure-Requests'] as const;

const quote = (value: string): string => `"${value}"`;

export const userAgentHeaders = (profile: RuntimeBrowserDeviceProfile): Record<string, string> => ({
  'Accept-Language': profile.acceptLanguage,
  ...(profile.dnt ? { DNT: '1' } : {}),
  'User-Agent': profile.userAgent,
});

/**
 * Chrome sends the WINDOW width, never the screen width, in `Viewport-Width`. Derived
 * deterministically from the profile id: a constant would correlate every installation,
 * and `availWidth` is a screen fact. One installation keeps one window size.
 */
export const deriveViewportWidth = (profile: RuntimeBrowserDeviceProfile): number => {
  let hash = 7;
  for (const character of profile.id)
    hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0;
  const shrinkPercent = hash % 21;
  return Math.max(360, Math.round((profile.screen.availWidth * (100 - shrinkPercent)) / 100));
};

/**
 * Chrome low/high-entropy User-Agent Client Hints derived from one profile.
 *
 * `low` is the trio every Chrome sends unconditionally. `high` is the full set Chrome
 * ONLY sends to an origin that delegated the hints with `Accept-CH` / `Critical-CH` —
 * sending an undelegated hint is a positive tell, so callers must know their origin
 * delegates before asking for it.
 *
 * chatgpt.com delegates nothing: a live unauthenticated capture through the impersonated
 * transport on 2026-08-18 (`GET https://chatgpt.com/` → 200, `GET /backend-api/me` → 401,
 * `GET /api/auth/session` → 200) carried no `Accept-CH`, no `Critical-CH` and no
 * `<meta http-equiv="accept-ch">` in the document — so the ChatGPT Web builders use
 * `low`. The `high` set mirrors a real Chrome under full delegation: raw (uncapped)
 * `Device-Memory` and a per-profile window width, as captured from Chrome 150 against a
 * fully delegating origin. Network-quality hints (`rtt` / `downlink` / `ect`) are
 * deliberately absent: they describe the connection, not the device, and no consumer
 * origin delegates them today.
 */
export const buildClientHintHeaders = (
  profile: RuntimeBrowserDeviceProfile,
  { entropy }: BrowserClientHintOptions,
): Record<string, string> => {
  const lowEntropy = {
    'Sec-Ch-Ua': profile.secChUa,
    'Sec-Ch-Ua-Mobile': profile.mobile ? '?1' : '?0',
    'Sec-Ch-Ua-Platform': quote(profile.platform),
  };
  if (entropy === 'low') return lowEntropy;

  return {
    ...lowEntropy,
    'Device-Memory': String(profile.deviceMemoryGiB),
    'Dpr': String(profile.screen.dpr),
    'Sec-Ch-Ua-Arch': quote(profile.arch),
    'Sec-Ch-Ua-Bitness': quote(profile.bitness),
    'Sec-Ch-Ua-Form-Factors': profile.formFactors.map(quote).join(', '),
    'Sec-Ch-Ua-Full-Version': quote(profile.chrome.fullVersion),
    'Sec-Ch-Ua-Full-Version-List': profile.secChUaFullVersionList,
    'Sec-Ch-Ua-Model': quote(profile.model),
    'Sec-Ch-Ua-Platform-Version': quote(profile.platformVersion),
    'Sec-Ch-Ua-Wow64': profile.wow64 ? '?1' : '?0',
    'Sec-Ch-Prefers-Color-Scheme': profile.prefersColorScheme,
    'Sec-Ch-Prefers-Reduced-Motion': profile.prefersReducedMotion,
    'Viewport-Width': String(deriveViewportWidth(profile)),
  };
};

/** Fetch Metadata for the four browser request shapes used by impersonating transports. */
export const buildFetchMetadataHeaders = (
  kind: BrowserFetchMetadataKind,
): Record<string, string> => {
  switch (kind) {
    case 'navigate': {
      return {
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      };
    }
    case 'image': {
      return {
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
      };
    }
    case 'cors-put': {
      return {
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
      };
    }
    case 'xhr': {
      return {
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      };
    }
  }
};
