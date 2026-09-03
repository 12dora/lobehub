import { BUILT_IN_RUNTIME_BRANDING } from '@lobechat/business-const';

import {
  NO_PLATFORM_BRANDING_THEME_DEFAULTS,
  resolveRuntimeBranding,
} from '@/types/platform/branding';
import { resolveSafePlatformPublicSnapshot } from '@/types/platform/publicSnapshot';
import { withRuntimeBrandingRevision } from '@/utils/favicon';

/** The published mark to paint. `logoSrc` is `null` when only the brand name can be shown. */
export interface PublishedBootBrand {
  logoSrc: string | null;
  name: string;
}

/**
 * Acceptance rule mirrored from `src/server/loadingBrand.ts`: only operator-supplied URLs that
 * are unambiguously an image source are accepted, so both splashes fall back to the text mark
 * on exactly the same inputs.
 */
const isSafeLogoUrl = (url: string): boolean => {
  if (url.startsWith('//') || url.startsWith('/\\')) return false;
  if (url.startsWith('/')) return true;
  if (/^data:image\/[\w.+-]+[,;]/i.test(url)) return true;

  return /^https?:\/\//i.test(url);
};

/** The payload is injected HTML, so treat it as untrusted rather than as its declared type. */
const readInjectedSnapshot = (): unknown => {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.__SERVER_CONFIG__?.platformPublicSnapshot;
  } catch {
    return undefined;
  }
};

const resolvePublishedBootBrand = (snapshot: unknown): PublishedBootBrand | null => {
  if (!snapshot) return null;

  // Same fallback as the server splash, so an unset field resolves to the same mark on both sides.
  const branding = resolveRuntimeBranding(resolveSafePlatformPublicSnapshot(snapshot).branding, {
    ...BUILT_IN_RUNTIME_BRANDING,
    themeDefaults: { ...NO_PLATFORM_BRANDING_THEME_DEFAULTS },
  });
  if (!branding.publishedRevision) return null;

  const logoUrl = branding.logoUrl?.trim();
  if (!logoUrl || !isSafeLogoUrl(logoUrl)) return { logoSrc: null, name: branding.name };

  return {
    // `data:` payloads are already immutable — appending a cache key would corrupt them.
    logoSrc: logoUrl.startsWith('data:')
      ? logoUrl
      : withRuntimeBrandingRevision(logoUrl, branding.publishedRevision),
    name: branding.name,
  };
};

const UNREAD = Symbol('unread');

let cachedSnapshot: unknown = UNREAD;
let cachedBrand: PublishedBootBrand | null = null;

/**
 * Synchronous published brand for the boot splash, or `null` when no brand is published
 * (and on desktop / auth shells / tests, where no snapshot is injected at all).
 *
 * The splash renders outside every provider, so the snapshot is read straight off the global
 * the SPA HTML injects before the bundle evaluates. Parsing is memoized per snapshot object:
 * it never changes for the lifetime of a page.
 */
export const readPublishedBootBrand = (): PublishedBootBrand | null => {
  const snapshot = readInjectedSnapshot();
  if (snapshot !== cachedSnapshot) {
    cachedSnapshot = snapshot;
    cachedBrand = resolvePublishedBootBrand(snapshot);
  }

  return cachedBrand;
};
