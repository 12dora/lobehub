// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RouteVariants } from '@/utils/server/routeVariants';

import { GET } from './route';

const mocks = vi.hoisted(() => ({
  getServerGlobalConfig: vi.fn(),
  resolvePlatformPublicSnapshot: vi.fn(),
  resolveServerRuntimeBranding: vi.fn(),
  resolveServerRuntimeBrandingFromPublicSnapshot: vi.fn(),
}));

vi.mock('@/server/enterprise/services/branding', () => ({
  resolvePlatformPublicSnapshot: mocks.resolvePlatformPublicSnapshot,
  resolveServerRuntimeBranding: mocks.resolveServerRuntimeBranding,
  resolveServerRuntimeBrandingFromPublicSnapshot:
    mocks.resolveServerRuntimeBrandingFromPublicSnapshot,
}));
vi.mock('@/server/globalConfig', () => ({ getServerGlobalConfig: mocks.getServerGlobalConfig }));
vi.mock('@/server/translation', () => ({
  translation: vi.fn(async () => ({
    t: (key: string, options?: { appName?: string }) => `${key}:${options?.appName ?? ''}`,
  })),
}));
vi.mock('./spaHtmlTemplates', () => ({
  desktopHtmlTemplate:
    '<html><head><!--SEO_META--><script>window.__SERVER_CONFIG__ = undefined; /* SERVER_CONFIG */</script></head></html>',
  mobileHtmlTemplate:
    '<html><head><!--SEO_META--><script>window.__SERVER_CONFIG__ = undefined; /* SERVER_CONFIG */</script></head></html>',
}));

describe('main SPA route runtime snapshot', () => {
  const publicSnapshot = {
    branding: {
      defaultAgentDisplayName: null,
      emailFrom: null,
      emailSenderName: null,
      faviconUrl: '/brand.ico?tenant=one',
      homeUrl: null,
      iconUrl: null,
      legalName: null,
      logoUrl: '/brand.png',
      name: 'Request Brand',
      ogImageUrl: null,
      pageTitleTemplate: null,
      privacyUrl: null,
      revision: '7',
      shortName: null,
      supportUrl: null,
      termsUrl: null,
    },
    brandingRevision: '7',
    configRevision: 'config-7',
    login: { workAccountEnabled: false },
    logoUrl: '/brand.png',
    platformName: 'Request Brand',
  };
  const branding = {
    ...publicSnapshot.branding,
    defaultAgentDisplayName: 'Request Brand AI',
    emailSenderName: 'Request Brand',
    iconUrl: '/brand.png',
    pageTitleTemplate: '%s · Request Brand',
    publishedRevision: '7',
    shortName: 'Request Brand',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerGlobalConfig.mockResolvedValue({ aiProvider: {}, telemetry: {} });
    mocks.resolvePlatformPublicSnapshot.mockResolvedValue(publicSnapshot);
    mocks.resolveServerRuntimeBrandingFromPublicSnapshot.mockReturnValue(branding);
  });

  it('resolves once and uses the same exact snapshot for SEO and safe config injection', async () => {
    const response = await GET(new Request('https://example.com'), {
      params: Promise.resolve({
        variants: RouteVariants.serializeVariants({ isMobile: false, locale: 'en-US' }),
      }),
    });
    const html = await response.text();

    expect(mocks.resolvePlatformPublicSnapshot).toHaveBeenCalledOnce();
    expect(mocks.resolveServerRuntimeBrandingFromPublicSnapshot).toHaveBeenCalledOnce();
    expect(mocks.resolveServerRuntimeBrandingFromPublicSnapshot).toHaveBeenCalledWith(
      publicSnapshot,
    );
    expect(mocks.resolveServerRuntimeBranding).not.toHaveBeenCalled();
    expect(html).toContain('"configRevision":"config-7"');
    expect(html).toContain('chat.title:Request Brand');
    expect(html).toContain('/brand.ico?tenant=one&amp;runtime_branding_revision=7');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
  });
});
