import { ORG_NAME } from '@lobechat/business-const';
import { OG_URL } from '@lobechat/const';
import urlJoin from 'url-join';

import { OFFICIAL_URL } from '@/const/url';
import { isCustomORG } from '@/const/version';
import { normalizeLocale } from '@/locales/resources';
import { resolveServerRuntimeBranding } from '@/server/enterprise/services/branding';
import { translation } from '@/server/translation';
import { escapeHtml } from '@/server/utils/html';
import type { RuntimeBranding } from '@/types/platform/branding';
import { withRuntimeBrandingRevision } from '@/utils/favicon';

interface AuthSeoEntry {
  canonicalPath?: string;
  description: string;
  title: string;
}

export async function buildAuthSeoEntry(
  locale: string,
  pathname: string,
  inputBranding?: RuntimeBranding,
): Promise<AuthSeoEntry> {
  const branding = inputBranding ?? (await resolveServerRuntimeBranding());
  const { t } = await translation('auth', normalizeLocale(locale));
  const normalizedPath =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

  switch (normalizedPath) {
    case '/signin': {
      return {
        canonicalPath: '/signin',
        description: t('signin.subtitle', { appName: branding.name }),
        title: t('betterAuth.signin.emailStep.title'),
      };
    }
    case '/signup': {
      return {
        canonicalPath: '/signup',
        description: t('betterAuth.signup.subtitle'),
        title: t('betterAuth.signup.title'),
      };
    }
    default: {
      return {
        description: t('signin.subtitle', { appName: branding.name }),
        title: branding.name,
      };
    }
  }
}

export async function buildSeoMeta(
  locale: string,
  pathname: string,
  inputBranding?: RuntimeBranding,
): Promise<string> {
  const branding = inputBranding ?? (await resolveServerRuntimeBranding());
  const lng = normalizeLocale(locale);
  const entry = await buildAuthSeoEntry(lng, pathname, branding);
  const { canonicalPath } = entry;
  const title = escapeHtml(entry.title);
  const description = escapeHtml(entry.description);
  const ogUrl = canonicalPath ? urlJoin(OFFICIAL_URL, canonicalPath) : OFFICIAL_URL;
  const ogImage = escapeHtml(branding.ogImageUrl ?? OG_URL);
  const favicon = branding.faviconUrl
    ? escapeHtml(withRuntimeBrandingRevision(branding.faviconUrl, branding.publishedRevision))
    : null;

  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${ogUrl}" />`,
    `<meta property="og:image" content="${ogImage}" />`,
    `<meta property="og:site_name" content="${escapeHtml(branding.name)}" />`,
    `<meta property="og:locale" content="${lng}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${ogImage}" />`,
    `<meta name="twitter:site" content="${isCustomORG ? `@${ORG_NAME}` : '@lobehub'}" />`,
    ...(favicon ? [`<link rel="icon" href="${favicon}" />`] : []),
  ].join('\n    ');
}
