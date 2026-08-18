// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { buildAnalyticsConfig, renderSpaHtml } from './spaHtml';

describe('renderSpaHtml', () => {
  it('injects server config, seo meta and strips the analytics placeholder', async () => {
    const template = [
      '<html><head>',
      '<!--SEO_META-->',
      '<script>window.__SERVER_CONFIG__ = undefined; /* SERVER_CONFIG */</script>',
      '</head><body><!--ANALYTICS_SCRIPTS--></body></html>',
    ].join('\n');

    const res = renderSpaHtml(template, {
      seoMeta: '<title>Hi</title>',
      serverConfig: { enableOIDC: true },
    });
    const html = await res.text();

    expect(html).toContain('window.__SERVER_CONFIG__ = {"enableOIDC":true};');
    expect(html).toContain('<title>Hi</title>');
    expect(html).not.toContain('SEO_META');
    expect(html).not.toContain('ANALYTICS_SCRIPTS');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  describe('loading brand slot', () => {
    const template = [
      '<body><div id="loading-brand">',
      '<!--LOADING_BRAND_START-->',
      '<svg><title>LobeHub</title><path d="M15 240" /></svg>',
      '<!--LOADING_BRAND_END-->',
      '</div>window.__SERVER_CONFIG__ = undefined; /* SERVER_CONFIG */</body>',
    ].join('\n');

    it('replaces the markers and everything between them', async () => {
      const res = renderSpaHtml(template, {
        loadingBrand: '<img alt="" class="loading-brand-logo" src="/logo.png" />',
        seoMeta: '',
        serverConfig: {},
      });
      const html = await res.text();

      expect(html).toContain('<img alt="" class="loading-brand-logo" src="/logo.png" />');
      expect(html).not.toContain('LOADING_BRAND_START');
      expect(html).not.toContain('LOADING_BRAND_END');
      expect(html).not.toContain('LobeHub');
      expect(html).toContain('<div id="loading-brand">');
    });

    it('keeps the built-in mark untouched when no loading brand is provided', async () => {
      const res = renderSpaHtml(template, { seoMeta: '', serverConfig: {} });
      const html = await res.text();

      expect(html).toContain('<!--LOADING_BRAND_START-->');
      expect(html).toContain('<title>LobeHub</title>');
    });

    it('treats `$&`-style sequences in the brand markup as literal text', async () => {
      const res = renderSpaHtml(template, {
        loadingBrand: '<div class="loading-brand-name">A$&B$\'C</div>',
        seoMeta: '',
        serverConfig: {},
      });

      expect(await res.text()).toContain('<div class="loading-brand-name">A$&B$\'C</div>');
    });
  });

  it('escapes script-breaking sequences in the server config', async () => {
    const template = 'window.__SERVER_CONFIG__ = undefined; /* SERVER_CONFIG */';
    const res = renderSpaHtml(template, {
      seoMeta: '',
      serverConfig: { html: '</script><script>alert(1)</script>' },
    });

    expect(await res.text()).not.toContain('</script>');
  });

  it('injects the exact strict public snapshot without executable prototype content', async () => {
    const template = 'window.__SERVER_CONFIG__ = undefined; /* SERVER_CONFIG */';
    const publicSnapshot = {
      branding: null,
      brandingRevision: null,
      configRevision: 'revision-7',
      login: { workAccountEnabled: false },
      logoUrl: null,
      platformName: null,
    };
    const hostileConfig = JSON.parse(
      '{"__proto__":{"polluted":true},"html":"</script><script>alert(1)</script>"}',
    );
    const res = renderSpaHtml(template, {
      seoMeta: '',
      serverConfig: { hostileConfig, platformPublicSnapshot: publicSnapshot },
    });
    const html = await res.text();

    expect(html).toContain('"platformPublicSnapshot"');
    expect(html).toContain('"configRevision":"revision-7"');
    expect(html).toContain('"__proto__"');
    expect(html).not.toContain('</script>');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('buildAnalyticsConfig', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DESKTOP_PROJECT_ID;
    delete process.env.NEXT_PUBLIC_DESKTOP_UMAMI_BASE_URL;
  });

  it('never configures desktop analytics — telemetry is removed (AIHub)', () => {
    process.env.NEXT_PUBLIC_DESKTOP_PROJECT_ID = 'pid';
    process.env.NEXT_PUBLIC_DESKTOP_UMAMI_BASE_URL = 'https://umami.example.com';

    expect(buildAnalyticsConfig().desktop).toBeUndefined();
    // Even when explicitly opted in, no desktop tracker config is emitted.
    expect(buildAnalyticsConfig({ desktop: true }).desktop).toBeUndefined();
  });
});
