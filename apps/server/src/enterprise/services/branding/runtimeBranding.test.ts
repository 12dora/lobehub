import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';

import { resolveServerRuntimeBranding } from './runtimeBranding';

describe('resolveServerRuntimeBranding', () => {
  it('does not touch the database when Runtime Branding is disabled', async () => {
    const getDatabase = vi.fn();

    const branding = await resolveServerRuntimeBranding({
      flags: DEFAULT_ENTERPRISE_FEATURE_FLAGS,
      getDatabase,
    });

    expect(getDatabase).not.toHaveBeenCalled();
    expect(branding.name).toBe('LobeHub');
    expect(branding.publishedRevision).toBeNull();
  });

  it('returns the exact strict Published revision', async () => {
    const database = {} as never;
    const getDatabase = vi.fn().mockResolvedValue(database);
    const getPublishedBranding = vi.fn().mockResolvedValue({
      defaultAgentDisplayName: null,
      emailFrom: null,
      emailSenderName: null,
      faviconUrl: null,
      homeUrl: null,
      iconUrl: '/icon.png',
      legalName: null,
      logoUrl: null,
      name: 'AIHub',
      ogImageUrl: null,
      pageTitleTemplate: null,
      privacyUrl: null,
      revision: '42',
      shortName: null,
      supportUrl: null,
      termsUrl: null,
    });

    const branding = await resolveServerRuntimeBranding({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
      getDatabase,
      getPublishedBranding,
    });

    expect(getDatabase).toHaveBeenCalledTimes(1);
    expect(getPublishedBranding).toHaveBeenCalledTimes(1);
    expect(branding).toMatchObject({ name: 'AIHub', publishedRevision: '42' });
  });

  it('fails closed to built-in branding when the database is unavailable', async () => {
    const branding = await resolveServerRuntimeBranding({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
      getDatabase: vi.fn().mockRejectedValue(new Error('offline')),
    });

    expect(branding.name).toBe('LobeHub');
    expect(branding.publishedRevision).toBeNull();
  });

  it('fails closed when an injected Published projection violates the strict schema', async () => {
    const branding = await resolveServerRuntimeBranding({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
      getDatabase: vi.fn().mockResolvedValue({}),
      getPublishedBranding: vi.fn().mockResolvedValue({
        name: '<script>alert(1)</script>',
        revision: '43',
      }),
    });

    expect(branding.name).toBe('LobeHub');
    expect(branding.publishedRevision).toBeNull();
  });
});
