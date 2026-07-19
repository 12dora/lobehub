import { describe, expect, it } from 'vitest';

import { DISABLED_PLATFORM_PUBLIC_SNAPSHOT } from '@/types/platform/publicSnapshot';

import { BUILT_IN_RUNTIME_BRANDING, resolveRuntimeBranding } from './runtimeBranding';

describe('resolveRuntimeBranding', () => {
  it('returns the synchronous built-in branding when no Published snapshot exists', () => {
    expect(resolveRuntimeBranding(DISABLED_PLATFORM_PUBLIC_SNAPSHOT)).toEqual(
      BUILT_IN_RUNTIME_BRANDING,
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
        pageTitleTemplate: null,
        privacyUrl: null,
        revision: '12',
        shortName: null,
        supportUrl: null,
        termsUrl: null,
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
    });
    expect(branding.emailFrom).toBe(BUILT_IN_RUNTIME_BRANDING.emailFrom);
  });
});
