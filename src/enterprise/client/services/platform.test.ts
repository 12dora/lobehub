import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lambdaClient } from '@/libs/trpc/client';
import { DISABLED_PLATFORM_CAPABILITIES } from '@/types/platform/capabilities';
import { DISABLED_PLATFORM_PUBLIC_SNAPSHOT } from '@/types/platform/publicSnapshot';

import { fetchPlatformCapabilities, fetchPlatformPublicSnapshot } from './platform';

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    platform: {
      getCapabilities: { query: vi.fn() },
      getPublicSnapshot: { query: vi.fn() },
    },
  },
}));

describe('enterprise platform client service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns server capabilities when available', async () => {
    vi.mocked(lambdaClient.platform.getCapabilities.query).mockResolvedValue({
      ...DISABLED_PLATFORM_CAPABILITIES,
      features: { ...DISABLED_PLATFORM_CAPABILITIES.features, platformAdmin: true },
    } as any);

    const caps = await fetchPlatformCapabilities();
    expect(caps.features.platformAdmin).toBe(true);
  });

  it('falls back to disabled snapshot on error', async () => {
    vi.mocked(lambdaClient.platform.getCapabilities.query).mockRejectedValue(new Error('offline'));
    await expect(fetchPlatformCapabilities()).resolves.toEqual(DISABLED_PLATFORM_CAPABILITIES);
  });

  it('falls back for public snapshot failures', async () => {
    vi.mocked(lambdaClient.platform.getPublicSnapshot.query).mockRejectedValue(new Error('x'));
    await expect(fetchPlatformPublicSnapshot()).resolves.toEqual(DISABLED_PLATFORM_PUBLIC_SNAPSHOT);
  });
});
