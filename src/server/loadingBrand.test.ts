// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { RuntimeBranding } from '@/types/platform/branding';

import { buildLoadingBrandMarkup } from './loadingBrand';

const createBranding = (overrides: Partial<RuntimeBranding> = {}): RuntimeBranding => ({
  defaultAgentDisplayName: null,
  emailFrom: null,
  emailSenderName: null,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  legalName: null,
  logoUrl: null,
  name: 'Acme Cloud',
  ogImageUrl: null,
  pageTitleTemplate: null,
  privacyUrl: null,
  publishedRevision: '7',
  shortName: null,
  supportUrl: null,
  termsUrl: null,
  themeDefaults: { primaryColor: null },
  ...overrides,
});

describe('buildLoadingBrandMarkup', () => {
  it('keeps the built-in wordmark when no brand revision is published', () => {
    expect(buildLoadingBrandMarkup(createBranding({ publishedRevision: null }))).toBeUndefined();
    // A logo without a publication is still not a published brand.
    expect(
      buildLoadingBrandMarkup(createBranding({ logoUrl: '/logo.png', publishedRevision: null })),
    ).toBeUndefined();
  });

  it('renders the published logo with a breathing animation and a revision cache key', () => {
    const markup = buildLoadingBrandMarkup(
      createBranding({ logoUrl: '/brand/logo.png?tenant=one' }),
    );

    expect(markup).toContain('class="loading-brand-logo"');
    expect(markup).toContain('src="/brand/logo.png?tenant=one&amp;runtime_branding_revision=7"');
    expect(markup).toContain('alt=""');
    expect(markup).toContain('loading-brand-breathe');
  });

  it('accepts absolute http(s) logos and leaves data:image payloads untouched', () => {
    expect(
      buildLoadingBrandMarkup(createBranding({ logoUrl: 'https://cdn.example.com/l.png' })),
    ).toContain('src="https://cdn.example.com/l.png?runtime_branding_revision=7"');

    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const markup = buildLoadingBrandMarkup(createBranding({ logoUrl: dataUrl }));

    expect(markup).toContain(`src="${dataUrl}"`);
    expect(markup).not.toContain('runtime_branding_revision');
  });

  it('falls back to the text mark when the logo url is not a safe image source', () => {
    for (const logoUrl of [
      'javascript:alert(1)',
      '//evil.example.com/logo.png',
      String.raw`/\evil.example.com/logo.png`,
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com/logo.png',
      '   ',
    ]) {
      const markup = buildLoadingBrandMarkup(createBranding({ logoUrl }));

      expect(markup).toContain('class="loading-brand-name"');
      expect(markup).not.toContain('<img');
      expect(markup).not.toContain('alert(1)');
    }
  });

  it('renders the brand name when no logo is configured', () => {
    const markup = buildLoadingBrandMarkup(createBranding());

    expect(markup).toContain('<div class="loading-brand-name">Acme Cloud</div>');
    expect(markup).toContain('loading-brand-sweep');
    expect(markup).toContain('currentcolor');
  });

  it('escapes the brand name so it cannot break out of the markup', () => {
    const markup = buildLoadingBrandMarkup(
      createBranding({ name: `</div><script>alert('x')</script>&"` }),
    );

    expect(markup).not.toContain('<script>');
    expect(markup).toContain(
      '&lt;/div&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;&quot;',
    );
  });
});
