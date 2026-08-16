import {
  BRANDING_EMAIL,
  BUILT_IN_RUNTIME_BRANDING as BUILT_IN_BRANDING,
} from '@lobechat/business-const';
import { describe, expect, it } from 'vitest';

import { mailTo, OFFICIAL_SITE, PRIVACY_URL, TERMS_URL } from '@/const/url';
import {
  NO_PLATFORM_BRANDING_THEME_DEFAULTS,
  resolveRuntimeBranding,
  type RuntimeBranding,
} from '@/types/platform/branding';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  resolveSafePlatformPublicSnapshot,
} from '@/types/platform/publicSnapshot';

import { resolveAboutLinks } from './resolveAboutLinks';

const BUILT_IN_RUNTIME_BRANDING: RuntimeBranding = {
  ...BUILT_IN_BRANDING,
  themeDefaults: { ...NO_PLATFORM_BRANDING_THEME_DEFAULTS },
};

describe('resolveAboutLinks', () => {
  it('uses product fallbacks when no Published links exist', () => {
    expect(resolveAboutLinks(BUILT_IN_RUNTIME_BRANDING)).toEqual({
      copyright: BUILT_IN_RUNTIME_BRANDING.legalName,
      officialSite: OFFICIAL_SITE,
      privacy: PRIVACY_URL,
      support: mailTo(BRANDING_EMAIL.support),
      terms: TERMS_URL,
    });
  });

  it('uses Published URLs and the legal name from one branding snapshot', () => {
    const branding = {
      ...BUILT_IN_RUNTIME_BRANDING,
      homeUrl: 'https://brand.example.com',
      legalName: 'Brand Legal Ltd',
      privacyUrl: 'https://brand.example.com/privacy',
      supportUrl: 'https://brand.example.com/support',
      termsUrl: 'https://brand.example.com/terms',
    };

    expect(resolveAboutLinks(branding)).toEqual({
      copyright: 'Brand Legal Ltd',
      officialSite: 'https://brand.example.com',
      privacy: 'https://brand.example.com/privacy',
      support: 'https://brand.example.com/support',
      terms: 'https://brand.example.com/terms',
    });
  });

  it('falls the copyright line back to the platform name when legalName is absent', () => {
    expect(
      resolveAboutLinks({
        ...BUILT_IN_RUNTIME_BRANDING,
        legalName: null,
        name: 'Acme Workspace',
      }).copyright,
    ).toBe('Acme Workspace');
  });

  it('fails closed to product links for an inconsistent injected snapshot', () => {
    const branding = resolveRuntimeBranding(
      resolveSafePlatformPublicSnapshot({
        ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
        branding: {
          defaultAgentDisplayName: null,
          emailFrom: null,
          emailSenderName: null,
          faviconUrl: null,
          homeUrl: 'https://attacker.example.com',
          iconUrl: null,
          legalName: 'Attacker Legal',
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
      }).branding,
      BUILT_IN_RUNTIME_BRANDING,
    );

    expect(resolveAboutLinks(branding)).toEqual({
      copyright: BUILT_IN_RUNTIME_BRANDING.legalName,
      officialSite: OFFICIAL_SITE,
      privacy: PRIVACY_URL,
      support: mailTo(BRANDING_EMAIL.support),
      terms: TERMS_URL,
    });
  });
});
