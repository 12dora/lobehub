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
    '/logo%2525252ESvGz',
  ])('rejects SVG asset fixture %s', (url) => {
    expect(platformBrandingAssetUrlSchema.safeParse(url).success).toBe(false);
  });

  it('rejects a path that is still changing at the bounded decode limit', () => {
    let encodedExtension = '%2ESvG';
    for (let index = 0; index < 10; index++)
      encodedExtension = encodeURIComponent(encodedExtension);

    expect(platformBrandingAssetUrlSchema.safeParse(`/logo${encodedExtension}`).success).toBe(
      false,
    );
  });

  it.each([
    'Brand\u0085Name',
    'Brand\u202EName',
    'Brand\u2066Name',
    'Brand\u200BName',
    'Brand\u3164Name',
  ])('rejects controls, bidi controls, and dangerous invisible text %#', (name) => {
    expect(platformBrandingPublishedSchema.safeParse({ ...publishedBranding, name }).success).toBe(
      false,
    );
  });

  it('normalizes safe text to NFC while preserving English and Chinese branding', () => {
    expect(
      platformBrandingPublishedSchema.parse({ ...publishedBranding, name: '  Cafe\u0301 中文  ' })
        .name,
    ).toBe('Café 中文');
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

  it('requires null compatibility fields when branding is null', () => {
    expect(
      platformPublicSnapshotSchema.safeParse({
        branding: null,
        brandingRevision: null,
        configRevision: '0',
        login: { workAccountEnabled: false },
        logoUrl: '/orphan.png',
        platformName: null,
      }).success,
    ).toBe(false);
  });

  it.each([
    { logoUrl: '/other.png', platformName: 'AIHub' },
    { logoUrl: '/logo.png', platformName: 'Other' },
  ])('rejects compatibility fields inconsistent with branding: %o', (compatibility) => {
    expect(
      platformPublicSnapshotSchema.safeParse({
        branding: publishedBranding,
        brandingRevision: '3',
        configRevision: '0',
        login: { workAccountEnabled: false },
        ...compatibility,
      }).success,
    ).toBe(false);
  });

  it.each([
    { logoUrl: 'javascript:alert(1)', platformName: null },
    { logoUrl: null, platformName: '<img src=x onerror=alert(1)>' },
  ])('rejects unsafe compatibility output: %o', (compatibility) => {
    expect(
      platformPublicSnapshotSchema.safeParse({
        branding: null,
        brandingRevision: null,
        configRevision: '0',
        login: { workAccountEnabled: false },
        ...compatibility,
      }).success,
    ).toBe(false);
  });
});
