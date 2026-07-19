import { ABOUT, FEEDBACK, PRIVACY_URL, TERMS_URL } from '@/const/url';
import type { RuntimeBranding } from '@/types/platform/branding';

export const resolveAuthFooterLinks = (branding: RuntimeBranding) => [
  { href: branding.homeUrl ?? ABOUT, labelKey: 'footer.home' as const },
  { href: branding.supportUrl ?? FEEDBACK, labelKey: 'footer.support' as const },
  { href: branding.termsUrl ?? TERMS_URL, labelKey: 'footer.terms' as const },
  { href: branding.privacyUrl ?? PRIVACY_URL, labelKey: 'footer.privacy' as const },
];
