import { escapeHtml } from '@/server/utils/html';
import type { RuntimeBranding } from '@/types/platform/branding';
import { withRuntimeBrandingRevision } from '@/utils/favicon';

/**
 * Markup emitted between the `<!--LOADING_BRAND_START-->` / `<!--LOADING_BRAND_END-->` markers of
 * `index.html`. It renders before any bundle (and therefore before i18n) boots, so it must stay
 * language neutral: the brand name itself is the only copy allowed.
 */

/**
 * Only operator-supplied URLs that are unambiguously an image source are accepted:
 * same-origin absolute paths, `http(s):` URLs and inline `data:image/*` payloads. Anything else
 * (`javascript:`, protocol-relative `//host`, backslash tricks) falls back to the text mark.
 */
const isSafeLogoUrl = (url: string): boolean => {
  if (url.startsWith('//') || url.startsWith('/\\')) return false;
  if (url.startsWith('/')) return true;
  if (/^data:image\/[\w.+-]+[,;]/i.test(url)) return true;

  return /^https?:\/\//i.test(url);
};

const LOADING_BRAND_STYLE = `<style>
@keyframes loading-brand-breathe {
  0%, 100% { opacity: 0.35; transform: scale(0.94); }
  50% { opacity: 1; transform: scale(1); }
}
@keyframes loading-brand-sweep {
  0% { -webkit-mask-position: 100% 0; mask-position: 100% 0; }
  100% { -webkit-mask-position: 0% 0; mask-position: 0% 0; }
}
@keyframes loading-brand-fill {
  0% { opacity: 0.2; }
  30% { opacity: 0.35; }
  100% { opacity: 1; }
}
#loading-brand .loading-brand-logo {
  display: block;
  width: auto;
  height: 64px;
  max-width: 240px;
  object-fit: contain;
  animation: loading-brand-breathe 2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
#loading-brand .loading-brand-name {
  max-width: 80vw;
  overflow: hidden;
  color: currentcolor;
  font-weight: 700;
  font-size: 32px;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  line-height: 1.2;
  white-space: nowrap;
  text-overflow: ellipsis;
  letter-spacing: -0.02em;
  -webkit-mask-image: linear-gradient(
    90deg,
    rgb(0 0 0 / 30%) 0%,
    rgb(0 0 0 / 30%) 35%,
    #000 50%,
    rgb(0 0 0 / 30%) 65%,
    rgb(0 0 0 / 30%) 100%
  );
  mask-image: linear-gradient(
    90deg,
    rgb(0 0 0 / 30%) 0%,
    rgb(0 0 0 / 30%) 35%,
    #000 50%,
    rgb(0 0 0 / 30%) 65%,
    rgb(0 0 0 / 30%) 100%
  );
  -webkit-mask-size: 300% 100%;
  mask-size: 300% 100%;
  animation:
    loading-brand-sweep 2s cubic-bezier(0.4, 0, 0.2, 1) infinite,
    loading-brand-fill 2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
</style>`;

const buildTextMark = (branding: RuntimeBranding): string =>
  `${LOADING_BRAND_STYLE}<div class="loading-brand-name">${escapeHtml(branding.name)}</div>`;

/**
 * Builds the boot splash mark for the published platform brand.
 *
 * Returns `undefined` when no custom brand is published so the template keeps its built-in
 * LobeHub wordmark animation byte for byte.
 */
export const buildLoadingBrandMarkup = (branding: RuntimeBranding): string | undefined => {
  if (!branding.publishedRevision) return undefined;

  const logoUrl = branding.logoUrl?.trim();
  if (!logoUrl || !isSafeLogoUrl(logoUrl)) return buildTextMark(branding);

  // `data:` payloads are already immutable — appending a cache key would corrupt them.
  const src = logoUrl.startsWith('data:')
    ? logoUrl
    : withRuntimeBrandingRevision(logoUrl, branding.publishedRevision);

  return `${LOADING_BRAND_STYLE}<img alt="" class="loading-brand-logo" src="${escapeHtml(src)}" />`;
};
