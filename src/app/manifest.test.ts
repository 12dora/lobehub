// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import manifest, { revalidate } from './manifest';

const mocks = vi.hoisted(() => ({
  resolveServerRuntimeBranding: vi.fn(),
}));

vi.mock('@/server/enterprise/services/branding', () => ({
  resolveServerRuntimeBranding: mocks.resolveServerRuntimeBranding,
}));

describe('runtime web manifest', () => {
  beforeEach(() => {
    mocks.resolveServerRuntimeBranding.mockResolvedValue({
      defaultAgentDisplayName: 'AIHub AI',
      emailFrom: null,
      emailSenderName: 'AIHub',
      faviconUrl: null,
      homeUrl: null,
      iconUrl: '/runtime-icon.png',
      legalName: null,
      logoUrl: null,
      name: 'AIHub',
      ogImageUrl: null,
      pageTitleTemplate: '%s · AIHub',
      privacyUrl: null,
      publishedRevision: '42',
      shortName: 'AI',
      supportUrl: null,
      termsUrl: null,
    });
  });

  it('hot-updates display fields while keeping the install id stable', async () => {
    const result = await manifest();

    expect(mocks.resolveServerRuntimeBranding).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: 'lobe-hub', name: 'AIHub', short_name: 'AI' });
    expect(result.icons).toEqual([{ src: '/runtime-icon.png?runtime_branding_revision=42' }]);
    expect(result.screenshots).toEqual([]);
  });

  it('uses a bounded Next manifest cache window', () => {
    expect(revalidate).toBe(30);
  });
});
