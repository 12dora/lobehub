import { describe, expect, it } from 'vitest';

import { formatRuntimePageTitle } from '@/types/platform/branding';
import { DISABLED_PLATFORM_PUBLIC_SNAPSHOT } from '@/types/platform/publicSnapshot';

import { BUILT_IN_RUNTIME_BRANDING, resolveRuntimeBranding } from './runtimeBranding';

describe('resolveRuntimeBranding', () => {
  it('returns the synchronous built-in branding when no Published snapshot exists', () => {
    expect(resolveRuntimeBranding(DISABLED_PLATFORM_PUBLIC_SNAPSHOT)).toEqual(
      BUILT_IN_RUNTIME_BRANDING,
    );
    expect(resolveRuntimeBranding(DISABLED_PLATFORM_PUBLIC_SNAPSHOT).defaultAgentDisplayName).toBe(
      'Lobe AI',
    );
    expect(resolveRuntimeBranding(DISABLED_PLATFORM_PUBLIC_SNAPSHOT).publishedRevision).toBeNull();
  });

  it('merges a partial Published projection without blanking fallback fields', () => {
    const branding = resolveRuntimeBranding({
      ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
      branding: {
        defaultAgentDisplayName: null,
        emailFrom: null,
        emailSenderName: null,
        faviconUrl: null,
        homeUrl: null,
        iconUrl: null,
        legalName: null,
        logoUrl: '/aihub.png',
        name: 'AIHub',
        ogImageUrl: null,
        pageTitleTemplate: 'Static title',
        privacyUrl: null,
        revision: '12',
        shortName: null,
        supportUrl: null,
        termsUrl: null,
        themeDefaults: { primaryColor: '#E4002B' },
      },
      brandingRevision: '12',
      logoUrl: '/aihub.png',
      platformName: 'AIHub',
    });

    expect(branding).toMatchObject({
      defaultAgentDisplayName: 'AIHub AI',
      logoUrl: '/aihub.png',
      name: 'AIHub',
      pageTitleTemplate: '%s · AIHub',
      publishedRevision: '12',
      shortName: 'AIHub',
      themeDefaults: { primaryColor: '#E4002B' },
    });
    expect(branding.emailFrom).toBe(BUILT_IN_RUNTIME_BRANDING.emailFrom);
    expect(branding.pageTitleTemplate).toBe('%s · AIHub');
  });

  it('formats route titles from the same Published template', () => {
    const branding = {
      ...BUILT_IN_RUNTIME_BRANDING,
      name: 'AIHub',
      pageTitleTemplate: '[%s] AIHub',
    };

    expect(formatRuntimePageTitle('Settings', branding)).toBe('[Settings] AIHub');
    expect(formatRuntimePageTitle('', branding)).toBe('AIHub');
  });

  it('fails closed when an injected snapshot has inconsistent compatibility fields', () => {
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
        logoUrl: '/attacker.png',
        name: 'Attacker',
        ogImageUrl: null,
        pageTitleTemplate: null,
        privacyUrl: null,
        revision: 'hostile',
        shortName: null,
        supportUrl: null,
        termsUrl: null,
      },
      brandingRevision: 'different',
      logoUrl: '/different.png',
      platformName: 'Different',
    });

    expect(branding).toEqual(BUILT_IN_RUNTIME_BRANDING);
  });
});
