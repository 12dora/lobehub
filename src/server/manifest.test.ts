// @vitest-environment node
import qs from 'query-string';
import { describe, expect, it, vi } from 'vitest';

import { Manifest, manifestModule } from './manifest';

vi.mock('@/server/utils/url', () => ({
  getCanonicalUrl: vi.fn().mockReturnValue('https://example.com/manifest.webmanifest'),
}));

describe('Manifest', () => {
  const manifest = new Manifest();

  describe('generate', () => {
    it('should generate a valid manifest object', () => {
      const input = {
        color: '#FF0000',
        description: 'Test description',
        iconRevision: '42',
        iconUrl: 'https://brand.example.com/icon.png',
        name: 'Test App',
        shortName: 'Test',
        id: 'test-app',
        icons: [{ purpose: 'any' as const, sizes: '192x192', url: 'icon.png' }],
        screenshots: [{ form_factor: 'wide' as const, url: 'screenshot.png' }],
      };

      const result = manifest.generate(input);

      expect(result).toMatchObject({
        background_color: input.color,
        description: input.description,
        name: input.name,
        short_name: input.shortName,
        id: input.id,
        icons: [{ src: 'https://brand.example.com/icon.png?runtime_branding_revision=42' }],
        screenshots: expect.arrayContaining([
          expect.objectContaining({
            form_factor: 'wide',
            sizes: '1280x676',
          }),
        ]),
      });
      expect(result.icons).toEqual([
        { src: 'https://brand.example.com/icon.png?runtime_branding_revision=42' },
      ]);
      expect(result.screenshots[0].src).toBe('screenshot.png?v=1');
    });

    it.each([
      '/brand/icon.png?tenant=one#mark',
      'https://brand.example.com/icon.jpg?tenant=one#mark',
      'https://brand.example.com/icon.webp',
    ])('declares runtime asset %s generically without invented metadata', (iconUrl) => {
      const result = manifest.generate({
        description: 'Test description',
        iconRevision: 'revision 2',
        iconUrl,
        icons: [],
        id: 'test-app',
        name: 'Test App',
        screenshots: [],
      });

      expect(result.icons).toHaveLength(1);
      expect(result.icons[0]).toEqual({
        src: expect.stringContaining('runtime_branding_revision=revision+2'),
      });
      expect(result.icons[0]).not.toHaveProperty('sizes');
      expect(result.icons[0]).not.toHaveProperty('type');
      expect(result.icons[0]).not.toHaveProperty('purpose');
      expect(result).toMatchObject({ id: 'test-app', scope: '/', start_url: '/' });
      expect(result.screenshots).toEqual([]);
    });

    it('retains truthful metadata for built-in PNG icons', () => {
      const result = manifest.generate({
        description: 'Test description',
        iconUrl: null,
        icons: [{ purpose: 'maskable', sizes: '192x192', url: '/icon.png' }],
        id: 'test-app',
        name: 'Test App',
        screenshots: [],
      });

      expect(result.icons).toEqual([
        expect.objectContaining({ purpose: 'maskable', sizes: '192x192', type: 'image/png' }),
      ]);
    });

    it('should use default color if not provided', () => {
      const input = {
        description: 'Test description',
        name: 'Test App',
        id: 'test-app',
        icons: [],
        screenshots: [],
      };

      const result = manifest.generate(input);

      expect(result.background_color).toBe('#000000');
      expect(result.theme_color).toBe('#000000');
    });
  });

  describe('_getImage', () => {
    it('should return correct image object', () => {
      const url = 'https://example.com/image.png';
      const version = 2;

      // @ts-ignore - Accessing private method for testing
      const result = manifest._getImage(url, version);

      expect(result).toEqual({
        cache_busting_mode: 'query',
        immutable: 'true',
        max_age: 31536000,
        src: qs.stringifyUrl({ query: { v: version }, url }),
      });
    });

    it('should use default version if not provided', () => {
      const url = 'https://example.com/image.png';

      // @ts-ignore - Accessing private method for testing
      const result = manifest._getImage(url);

      expect(result.src).toContain('v=1');
    });
  });

  describe('_getIcon', () => {
    it('should return correct icon object', () => {
      const icon = {
        url: 'https://example.com/icon.png',
        version: 3,
        sizes: '64x64',
        purpose: 'maskable' as const,
      };

      // @ts-ignore - Accessing private method for testing
      const result = manifest._getIcon(icon);

      expect(result).toMatchObject({
        purpose: 'maskable',
        sizes: '64x64',
        type: 'image/png',
      });
      expect(result.src).toContain('v=3');
    });
  });

  describe('_getScreenshot', () => {
    it('should return correct screenshot object for wide form factor', () => {
      const screenshot = {
        form_factor: 'wide' as const,
        url: 'https://example.com/screenshot.png',
        version: 4,
      };

      // @ts-ignore - Accessing private method for testing
      const result = manifest._getScreenshot(screenshot);

      expect(result).toMatchObject({
        form_factor: 'wide',
        sizes: '1280x676',
        type: 'image/png',
      });
      expect(result.src).toContain('v=4');
    });

    it('should return correct screenshot object for narrow form factor', () => {
      const screenshot = {
        form_factor: 'narrow' as const,
        url: 'https://example.com/screenshot.png',
        sizes: '320x569',
      };

      // @ts-ignore - Accessing private method for testing
      const result = manifest._getScreenshot(screenshot);

      expect(result).toMatchObject({
        cache_busting_mode: 'query',
        form_factor: 'narrow',
        immutable: 'true',
        max_age: 31536000,
        sizes: '320x569',
        src: 'https://example.com/screenshot.png?v=1',
        type: 'image/png',
      });
    });
  });
});

describe('manifestModule', () => {
  it('should be an instance of Manifest', () => {
    expect(manifestModule).toBeInstanceOf(Manifest);
  });
});
