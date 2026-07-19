import {
  BRANDING_EMAIL,
  BRANDING_LOGO_URL,
  BRANDING_NAME,
  BRANDING_URL,
  ORG_NAME,
} from '@lobechat/business-const';

import type { PlatformBrandingPublished } from '@/types/platform/branding';
import type { PlatformPublicSnapshot } from '@/types/platform/publicSnapshot';

export interface RuntimeBranding extends Omit<PlatformBrandingPublished, 'revision'> {
  publishedRevision: string | null;
}

export const BUILT_IN_RUNTIME_BRANDING: RuntimeBranding = {
  defaultAgentDisplayName: `${BRANDING_NAME} AI`,
  emailFrom: BRANDING_EMAIL.support,
  emailSenderName: BRANDING_NAME,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  legalName: ORG_NAME,
  logoUrl: BRANDING_LOGO_URL || null,
  name: BRANDING_NAME,
  ogImageUrl: null,
  pageTitleTemplate: `%s · ${BRANDING_NAME}`,
  privacyUrl: BRANDING_URL.privacy ?? null,
  publishedRevision: null,
  shortName: BRANDING_NAME,
  supportUrl: BRANDING_URL.support ?? BRANDING_URL.help ?? null,
  termsUrl: BRANDING_URL.terms ?? null,
};

/** Field-by-field fallback prevents partial Published values from creating blank branding. */
export const resolveRuntimeBranding = (snapshot: PlatformPublicSnapshot): RuntimeBranding => {
  const published = snapshot.branding;
  if (!published) return { ...BUILT_IN_RUNTIME_BRANDING };

  return {
    defaultAgentDisplayName: published.defaultAgentDisplayName ?? `${published.name} AI`,
    emailFrom: published.emailFrom ?? BUILT_IN_RUNTIME_BRANDING.emailFrom,
    emailSenderName: published.emailSenderName ?? published.name,
    faviconUrl: published.faviconUrl ?? BUILT_IN_RUNTIME_BRANDING.faviconUrl,
    homeUrl: published.homeUrl ?? BUILT_IN_RUNTIME_BRANDING.homeUrl,
    iconUrl: published.iconUrl ?? published.logoUrl ?? BUILT_IN_RUNTIME_BRANDING.iconUrl,
    legalName: published.legalName ?? BUILT_IN_RUNTIME_BRANDING.legalName,
    logoUrl: published.logoUrl ?? BUILT_IN_RUNTIME_BRANDING.logoUrl,
    name: published.name,
    ogImageUrl: published.ogImageUrl ?? BUILT_IN_RUNTIME_BRANDING.ogImageUrl,
    pageTitleTemplate: published.pageTitleTemplate ?? `%s · ${published.name}`,
    privacyUrl: published.privacyUrl ?? BUILT_IN_RUNTIME_BRANDING.privacyUrl,
    publishedRevision: published.revision,
    shortName: published.shortName ?? published.name,
    supportUrl: published.supportUrl ?? BUILT_IN_RUNTIME_BRANDING.supportUrl,
    termsUrl: published.termsUrl ?? BUILT_IN_RUNTIME_BRANDING.termsUrl,
  };
};
