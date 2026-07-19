import { describe, expect, it } from 'vitest';

import { ABOUT, FEEDBACK, PRIVACY_URL, TERMS_URL } from '@/const/url';
import {
  BUILT_IN_RUNTIME_BRANDING,
  resolveRuntimeBranding,
} from '@/enterprise/client/providers/runtimeBranding';
import { DISABLED_PLATFORM_PUBLIC_SNAPSHOT } from '@/types/platform/publicSnapshot';

import { resolveAuthFooterLinks } from './resolveAuthFooterLinks';

describe('resolveAuthFooterLinks', () => {
  it('uses safe product fallbacks when no Published links exist', () => {
    expect(resolveAuthFooterLinks(BUILT_IN_RUNTIME_BRANDING)).toEqual([
      { href: ABOUT, labelKey: 'footer.home' },
      { href: FEEDBACK, labelKey: 'footer.support' },
      { href: TERMS_URL, labelKey: 'footer.terms' },
      { href: PRIVACY_URL, labelKey: 'footer.privacy' },
    ]);
  });

  it('uses the four strict Published URLs from one branding snapshot', () => {
    const branding = {
      ...BUILT_IN_RUNTIME_BRANDING,
      homeUrl: 'https://brand.example.com',
      privacyUrl: 'https://brand.example.com/privacy',
      supportUrl: 'https://brand.example.com/support',
      termsUrl: 'https://brand.example.com/terms',
    };

    expect(resolveAuthFooterLinks(branding).map(({ href }) => href)).toEqual([
      'https://brand.example.com',
      'https://brand.example.com/support',
      'https://brand.example.com/terms',
      'https://brand.example.com/privacy',
    ]);
  });

  it('fails closed to product links for an inconsistent injected snapshot', () => {
    const branding = resolveRuntimeBranding({
      ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
      branding: {
        defaultAgentDisplayName: null,
        emailFrom: null,
        emailSenderName: null,
        faviconUrl: null,
        homeUrl: 'https://attacker.example.com',
        iconUrl: null,
        legalName: null,
        logoUrl: null,
        name: 'Attacker',
        ogImageUrl: null,
        pageTitleTemplate: null,
        privacyUrl: 'https://attacker.example.com/privacy',
        revision: 'hostile',
        shortName: null,
        supportUrl: 'https://attacker.example.com/support',
        termsUrl: 'https://attacker.example.com/terms',
      },
      brandingRevision: 'different',
      platformName: 'Different',
    });

    expect(resolveAuthFooterLinks(branding).map(({ href }) => href)).toEqual([
      ABOUT,
      FEEDBACK,
      TERMS_URL,
      PRIVACY_URL,
    ]);
  });
});
