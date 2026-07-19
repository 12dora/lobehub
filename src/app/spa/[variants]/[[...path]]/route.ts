import { ORG_NAME } from '@lobechat/business-const';
import { OG_URL } from '@lobechat/const';

import { getServerFeatureFlagsValue } from '@/config/featureFlags';
import { OFFICIAL_URL } from '@/const/url';
import { isCustomORG, isDesktop } from '@/const/version';
import { appEnv } from '@/envs/app';
import { fileEnv } from '@/envs/file';
import { pythonEnv } from '@/envs/python';
import { type Locales } from '@/locales/resources';
import { parseEnterpriseFeatureFlags } from '@/server/enterprise/featureFlags';
import {
  resolvePlatformPublicSnapshot,
  resolveServerRuntimeBranding,
  resolveServerRuntimeBrandingFromPublicSnapshot,
} from '@/server/enterprise/services/branding';
import { getServerGlobalConfig } from '@/server/globalConfig';
import { buildAnalyticsConfig, fetchViteDevTemplate, renderSpaHtml } from '@/server/spaHtml';
import { translation } from '@/server/translation';
import { escapeHtml } from '@/server/utils/html';
import type { RuntimeBranding } from '@/types/platform/branding';
import { type SPAClientEnv, type SPAServerConfig } from '@/types/spaServerConfig';
import { withRuntimeBrandingRevision } from '@/utils/favicon';
import { RouteVariants } from '@/utils/server/routeVariants';

export function generateStaticParams() {
  const mobileOptions = isDesktop ? [false] : [true, false];
  const staticLocales: Locales[] = ['en-US', 'zh-CN'];

  const variants: { variants: string }[] = [];

  for (const locale of staticLocales) {
    for (const isMobile of mobileOptions) {
      variants.push({
        variants: RouteVariants.serializeVariants({ isMobile, locale }),
      });
    }
  }

  return variants;
}

const isDev = process.env.NODE_ENV === 'development';

async function getTemplate(isMobile: boolean): Promise<string> {
  if (isDev) return fetchViteDevTemplate();

  const { desktopHtmlTemplate, mobileHtmlTemplate } = await import('./spaHtmlTemplates');

  return isMobile ? mobileHtmlTemplate : desktopHtmlTemplate;
}

function buildClientEnv(): SPAClientEnv {
  return {
    marketBaseUrl: appEnv.MARKET_BASE_URL,
    pyodideIndexUrl: pythonEnv.NEXT_PUBLIC_PYODIDE_INDEX_URL,
    pyodidePipIndexUrl: pythonEnv.NEXT_PUBLIC_PYODIDE_PIP_INDEX_URL,
    s3FilePath: fileEnv.NEXT_PUBLIC_S3_FILE_PATH,
  };
}

export async function buildSeoMeta(
  locale: string,
  inputBranding?: RuntimeBranding,
): Promise<string> {
  const branding = inputBranding ?? (await resolveServerRuntimeBranding());
  const { t } = await translation('metadata', locale);
  const title = escapeHtml(t('chat.title', { appName: branding.name }));
  const description = escapeHtml(t('chat.description', { appName: branding.name }));
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
    `<meta property="og:url" content="${OFFICIAL_URL}" />`,
    `<meta property="og:image" content="${ogImage}" />`,
    `<meta property="og:site_name" content="${escapeHtml(branding.name)}" />`,
    `<meta property="og:locale" content="${escapeHtml(locale)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${ogImage}" />`,
    `<meta name="twitter:site" content="${isCustomORG ? `@${ORG_NAME}` : '@lobehub'}" />`,
    ...(favicon ? [`<link rel="icon" href="${favicon}" />`] : []),
  ].join('\n    ');
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path?: string[]; variants: string }> },
) {
  const { variants } = await params;
  const { locale, isMobile } = RouteVariants.deserializeVariants(variants);
  const platformPublicSnapshot = await resolvePlatformPublicSnapshot({
    flags: parseEnterpriseFeatureFlags(process.env),
  });
  const branding = resolveServerRuntimeBrandingFromPublicSnapshot(platformPublicSnapshot);

  const spaConfig: SPAServerConfig = {
    analyticsConfig: buildAnalyticsConfig({ desktop: true }),
    clientEnv: buildClientEnv(),
    config: await getServerGlobalConfig(),
    featureFlags: getServerFeatureFlagsValue(),
    isMobile,
    platformPublicSnapshot,
  };

  const template = await getTemplate(isMobile);
  const seoMeta = await buildSeoMeta(locale, branding);

  return renderSpaHtml(template, { seoMeta, serverConfig: spaConfig });
}
