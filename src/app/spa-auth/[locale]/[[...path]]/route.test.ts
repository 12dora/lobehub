// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const mocks = vi.hoisted(() => ({
  bootstrapIdentityProviderRuntime: vi.fn(async () => undefined),
  getServerAuthConfig: vi.fn(),
  resolvePlatformPublicSnapshot: vi.fn(),
  resolveServerRuntimeBranding: vi.fn(),
  resolveServerRuntimeBrandingFromPublicSnapshot: vi.fn(),
}));

vi.mock('@/server/enterprise/services/identityProvider/bootstrap', () => ({
  bootstrapIdentityProviderRuntime: mocks.bootstrapIdentityProviderRuntime,
}));

vi.mock('@/server/enterprise/services/branding', () => ({
  resolvePlatformPublicSnapshot: mocks.resolvePlatformPublicSnapshot,
  resolveServerRuntimeBranding: mocks.resolveServerRuntimeBranding,
  resolveServerRuntimeBrandingFromPublicSnapshot:
    mocks.resolveServerRuntimeBrandingFromPublicSnapshot,
}));
vi.mock('@/server/globalConfig/getServerAuthConfig', () => ({
  getServerAuthConfig: mocks.getServerAuthConfig,
}));
vi.mock('@/server/translation', () => ({
  translation: vi.fn(async () => ({
    t: (key: string, options?: { appName?: string }) => `${key}:${options?.appName ?? ''}`,
  })),
}));
vi.mock('../../authHtmlTemplate', () => ({
  authHtmlTemplate:
    '<html><head><!--SEO_META--><script>window.__SERVER_CONFIG__ = undefined; /* SERVER_CONFIG */</script></head></html>',
}));

describe('auth SPA route runtime snapshot', () => {
  const publicSnapshot = {
    branding: {
      defaultAgentDisplayName: null,
      emailFrom: null,
      emailSenderName: null,
      faviconUrl: '/brand.webp?tenant=one',
      homeUrl: null,
      iconUrl: null,
      legalName: null,
      logoUrl: '/brand.png',
      name: 'Auth Brand',
      ogImageUrl: null,
      pageTitleTemplate: null,
      privacyUrl: null,
      revision: '8',
      shortName: null,
      supportUrl: null,
      termsUrl: null,
    },
    brandingRevision: '8',
    configRevision: 'config-8',
    login: { workAccountEnabled: true },
    logoUrl: '/brand.png',
    platformName: 'Auth Brand',
  };
  const branding = {
    ...publicSnapshot.branding,
    defaultAgentDisplayName: 'Auth Brand AI',
    emailSenderName: 'Auth Brand',
    iconUrl: '/brand.png',
    pageTitleTemplate: '%s · Auth Brand',
    publishedRevision: '8',
    shortName: 'Auth Brand',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bootstrapIdentityProviderRuntime.mockResolvedValue(undefined);
    mocks.getServerAuthConfig.mockReturnValue({ enterprise: { enabled: true } });
    mocks.resolvePlatformPublicSnapshot.mockResolvedValue(publicSnapshot);
    mocks.resolveServerRuntimeBrandingFromPublicSnapshot.mockReturnValue(branding);
  });

  it('resolves once and uses the same exact snapshot for SEO and safe config injection', async () => {
    const response = await GET(new Request('https://example.com/signin'), {
      params: Promise.resolve({ locale: 'en-US', path: ['signin'] }),
    });
    const html = await response.text();

    expect(mocks.resolvePlatformPublicSnapshot).toHaveBeenCalledOnce();
    expect(mocks.bootstrapIdentityProviderRuntime).toHaveBeenCalledOnce();
    expect(mocks.resolveServerRuntimeBrandingFromPublicSnapshot).toHaveBeenCalledOnce();
    expect(mocks.resolveServerRuntimeBrandingFromPublicSnapshot).toHaveBeenCalledWith(
      publicSnapshot,
    );
    expect(mocks.resolveServerRuntimeBranding).not.toHaveBeenCalled();
    expect(html).toContain('"configRevision":"config-8"');
    expect(html).toContain('signin.subtitle:Auth Brand');
    expect(html).toContain('/brand.webp?tenant=one&amp;runtime_branding_revision=8');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
  });
});
