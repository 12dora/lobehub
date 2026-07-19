import { describe, expect, it } from 'vitest';

import {
  platformBrandingAssetUrlSchema,
  platformBrandingDraftSchema,
  platformBrandingLinkUrlSchema,
  platformBrandingPublishedSchema,
} from './branding';
import { platformPublicSnapshotSchema } from './publicSnapshot';

const publishedBranding = {
  defaultAgentDisplayName: null,
  emailFrom: null,
  emailSenderName: null,
  faviconUrl: '/favicon.png',
  homeUrl: 'https://example.com',
  iconUrl: null,
  legalName: null,
  logoUrl: '/logo.png',
  name: 'AIHub',
  ogImageUrl: null,
  pageTitleTemplate: null,
  privacyUrl: null,
  revision: '3',
  shortName: null,
  supportUrl: null,
  termsUrl: null,
};

describe('platform branding contracts', () => {
  it('accepts safe absolute links and root-relative raster assets', () => {
    expect(platformBrandingLinkUrlSchema.parse('https://example.com/help')).toBe(
      'https://example.com/help',
    );
    expect(platformBrandingAssetUrlSchema.parse('/assets/logo.webp')).toBe('/assets/logo.webp');
    expect(platformBrandingPublishedSchema.parse(publishedBranding)).toEqual(publishedBranding);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.example/logo.png',
    'https://user:password@example.com/logo.png',
    'https://example.com/logo.png" onerror="alert(1)',
  ])('rejects malicious URL fixture %s', (url) => {
    expect(platformBrandingLinkUrlSchema.safeParse(url).success).toBe(false);
    expect(platformBrandingAssetUrlSchema.safeParse(url).success).toBe(false);
  });

  it.each([
    '/logo.svg',
    '/logo.SVG?cache=1',
    'https://example.com/logo.svg#icon',
    'https://example.com/logo%2Esvg',
    '/logo.svgz',
  ])('rejects SVG asset fixture %s', (url) => {
    expect(platformBrandingAssetUrlSchema.safeParse(url).success).toBe(false);
  });

  it('keeps draft, published, and public snapshot objects strict', () => {
    const draft = { ...publishedBranding, name: null, revision: 0 };
    expect(platformBrandingDraftSchema.safeParse({ ...draft, secret: 'nope' }).success).toBe(false);
    expect(
      platformBrandingPublishedSchema.safeParse({ ...publishedBranding, createdBy: 'admin' })
        .success,
    ).toBe(false);
    expect(
      platformPublicSnapshotSchema.safeParse({
        adminAccess: true,
        branding: publishedBranding,
        brandingRevision: '3',
        configRevision: '0',
        login: { workAccountEnabled: false },
        logoUrl: '/logo.png',
        platformName: 'AIHub',
      }).success,
    ).toBe(false);
  });

  it('rejects a snapshot whose revision does not match its branding payload', () => {
    expect(
      platformPublicSnapshotSchema.safeParse({
        branding: publishedBranding,
        brandingRevision: '4',
        configRevision: '0',
        login: { workAccountEnabled: false },
        logoUrl: '/logo.png',
        platformName: 'AIHub',
      }).success,
    ).toBe(false);
  });
});
