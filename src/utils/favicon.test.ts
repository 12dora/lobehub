import { describe, expect, it } from 'vitest';

import { resolveFaviconHref, withRuntimeBrandingRevision } from './favicon';

describe('runtime favicon', () => {
  it.each([
    [
      '/favicon.webp?tenant=one#mark',
      '/favicon.webp?tenant=one&runtime_branding_revision=revision+2#mark',
    ],
    [
      'https://brand.example.com/favicon.jpg?tenant=one#mark',
      'https://brand.example.com/favicon.jpg?tenant=one&runtime_branding_revision=revision+2#mark',
    ],
    [
      'https://brand.example.com/favicon.png',
      'https://brand.example.com/favicon.png?runtime_branding_revision=revision+2',
    ],
  ])('preserves URL data while revisioning %s', (url, expected) => {
    expect(withRuntimeBrandingRevision(url, 'revision 2')).toBe(expected);
  });

  it('uses the exact Published favicon in the default state', () => {
    expect(
      resolveFaviconHref('default', false, '/tenant.ico?color=blue', '7', undefined, 100),
    ).toBe('/tenant.ico?color=blue&runtime_branding_revision=7');
  });

  it.each(['progress', 'done', 'error'] as const)(
    'keeps the built-in %s boundary favicon instead of masking status',
    (state) => {
      const href = resolveFaviconHref(state, false, '/tenant.ico', '7', '32x32', 100);

      expect(href).toBe(`/favicon-32x32-${state}.ico?v=100`);
      expect(href).not.toContain('tenant');
    },
  );

  it('changes the cache key when the Published revision changes', () => {
    expect(resolveFaviconHref('default', false, '/tenant.ico', '7')).not.toBe(
      resolveFaviconHref('default', false, '/tenant.ico', '8'),
    );
  });
});
