// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { type Cache, SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getScopedCache, mutate as scopedMutate } from '@/libs/swr';

import SWRMutateInitializer from './SWRMutateInitializer';
import DesktopSWRMutateInitializer from './SWRMutateInitializer.desktop';

vi.mock('@lobechat/electron-client-ipc', () => ({
  useWatchBroadcast: vi.fn(),
}));

/**
 * Both initializers publish the same two things. The desktop build swaps one
 * file for the other, so a capability added to the base variant and forgotten
 * here degrades silently: `getScopedCache()` stays null and every eviction
 * quietly becomes a blank-but-keep.
 */
const variants = [
  { Component: SWRMutateInitializer, name: 'web' },
  { Component: DesktopSWRMutateInitializer, name: 'desktop' },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(variants)('SWRMutateInitializer ($name)', ({ Component }) => {
  it('publishes the scoped cache and mutate for use outside React', async () => {
    const cache = new Map<string, unknown>();

    render(
      <SWRConfig value={{ provider: () => cache as unknown as Cache }}>
        <Component />
      </SWRConfig>,
    );

    expect(getScopedCache()).toBe(cache);

    // And the published mutate reaches that same cache.
    await scopedMutate('probe-key', 'written', { revalidate: false });
    expect([...cache.keys()]).toContain('probe-key');
  });
});
