import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DISABLED_PLATFORM_CAPABILITIES } from '@/types/platform/capabilities';
import { DISABLED_PLATFORM_PUBLIC_SNAPSHOT } from '@/types/platform/publicSnapshot';

import { fetchPlatformCapabilities, fetchPlatformPublicSnapshot } from './platform';

describe('enterprise platform client service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns server capabilities when available', async () => {
    const query = vi.fn().mockResolvedValue({
      ...DISABLED_PLATFORM_CAPABILITIES,
      features: { ...DISABLED_PLATFORM_CAPABILITIES.features, platformAdmin: true },
    });

    const caps = await fetchPlatformCapabilities(query);
    expect(caps.features.platformAdmin).toBe(true);
  });

  it('propagates capability errors so enabled enterprise policy cannot fail open', async () => {
    const query = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(fetchPlatformCapabilities(query)).rejects.toThrow('offline');
  });

  it('propagates public snapshot failures so SWR can retain fallback or last-known data', async () => {
    const query = vi.fn().mockRejectedValue(new Error('x'));
    await expect(fetchPlatformPublicSnapshot(query)).rejects.toThrow('x');
  });

  it('strictly parses a remotely fetched public snapshot', async () => {
    const query = vi.fn().mockResolvedValue(DISABLED_PLATFORM_PUBLIC_SNAPSHOT);

    await expect(fetchPlatformPublicSnapshot(query)).resolves.toEqual(
      DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
    );
  });

  it('rejects an inconsistent remotely fetched public snapshot', async () => {
    const query = vi.fn().mockResolvedValue({
      ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
      brandingRevision: 'unexpected',
    });

    await expect(fetchPlatformPublicSnapshot(query)).rejects.toThrow();
  });
});
