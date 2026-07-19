import { ORG_NAME } from '@lobechat/business-const';
import { OG_URL } from '@lobechat/const';

import { DEFAULT_LANG } from '@/const/locale';
import { OFFICIAL_URL } from '@/const/url';
import { isCustomORG } from '@/const/version';
import { resolveServerRuntimeBranding } from '@/server/enterprise/services/branding';
import { translation } from '@/server/translation';
import { type DynamicLayoutProps } from '@/types/next';
import { RouteVariants } from '@/utils/server/routeVariants';

const isDev = process.env.NODE_ENV === 'development';

export const generateMetadata = async (props: DynamicLayoutProps) => {
  const locale = await RouteVariants.getLocale(props);
  const [{ t }, branding] = await Promise.all([
    translation('metadata', locale),
    resolveServerRuntimeBranding(),
  ]);
  const description = t('chat.description', { appName: branding.name });
  const title = t('chat.title', { appName: branding.name });
  const ogImage = branding.ogImageUrl ?? OG_URL;
  const icon = branding.faviconUrl ?? branding.iconUrl ?? branding.logoUrl;

  return {
    alternates: {
      canonical: OFFICIAL_URL,
    },
    appleWebApp: {
      statusBarStyle: 'black-translucent',
      title: branding.shortName,
    },
    description,
    icons: icon || {
      apple: '/apple-touch-icon.png?v=1',
      icon: isDev ? '/favicon-dev.ico' : '/favicon.ico?v=1',
      shortcut: isDev ? '/favicon-32x32-dev.ico' : '/favicon-32x32.ico?v=1',
    },
    manifest: '/manifest.json',
    metadataBase: new URL(OFFICIAL_URL),
    openGraph: {
      description,
      images: [
        {
          alt: title,
          height: 640,
          url: ogImage,
          width: 1200,
        },
      ],
      locale: DEFAULT_LANG,
      siteName: branding.name,
      title: branding.name,
      type: 'website',
      url: OFFICIAL_URL,
    },
    title: {
      default: title,
      template: branding.pageTitleTemplate ?? `%s · ${branding.name}`,
    },
    twitter: {
      card: 'summary_large_image',
      description,
      images: [ogImage],
      site: isCustomORG ? `@${ORG_NAME}` : '@lobehub',
      title,
    },
  };
};
