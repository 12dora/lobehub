import { BRANDING_EMAIL } from '@lobechat/business-const';

import { mailTo, OFFICIAL_SITE, PRIVACY_URL, TERMS_URL } from '@/const/url';
import type { RuntimeBranding } from '@/types/platform/branding';

export interface AboutLinks {
  copyright: string;
  officialSite: string;
  privacy: string;
  support: string;
  terms: string;
}

/** Maps Published branding onto the Settings → About link set, with product fallbacks. */
export const resolveAboutLinks = (branding: RuntimeBranding): AboutLinks => ({
  copyright: branding.legalName ?? branding.name,
  officialSite: branding.homeUrl ?? OFFICIAL_SITE,
  privacy: branding.privacyUrl ?? PRIVACY_URL,
  support: branding.supportUrl ?? mailTo(BRANDING_EMAIL.support),
  terms: branding.termsUrl ?? TERMS_URL,
});
