// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { SWRConfig } from 'swr';
import { describe, expect, it, vi } from 'vitest';

import { DISABLED_PLATFORM_CAPABILITIES } from '@/types/platform/capabilities';
import type { PlatformPublicSnapshot } from '@/types/platform/publicSnapshot';

import { useEnterprisePlatformData } from './useEnterprisePlatformData';

const createSnapshot = (
  brandingRevision: string,
  name: string,
  configRevision = 'shared-config',
): PlatformPublicSnapshot => ({
  branding: {
    defaultAgentDisplayName: null,
    emailFrom: null,
    emailSenderName: null,
    faviconUrl: null,
    homeUrl: null,
    iconUrl: null,
    legalName: null,
    logoUrl: `/${brandingRevision}.png`,
    name,
    ogImageUrl: null,
    pageTitleTemplate: null,
    privacyUrl: null,
    revision: brandingRevision,
    shortName: null,
    supportUrl: null,
    termsUrl: null,
  },
  brandingRevision,
  configRevision,
  login: { openRegistration: true, workAccountEnabled: false },
  logoUrl: `/${brandingRevision}.png`,
  platformName: name,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};

describe('useEnterprisePlatformData with real SWR cache', () => {
  it('renders injected revision B before revalidation when revision A is cached under the same config revision', async () => {
    const cache = new Map();
    const wrapper = ({ children }: PropsWithChildren) => (
      <SWRConfig
        value={{
          dedupingInterval: 0,
          provider: () => cache,
          shouldRetryOnError: false,
        }}
      >
        {children}
      </SWRConfig>
    );
    const revisionA = createSnapshot('A', 'Brand A');
    const revisionB = createSnapshot('B', 'Brand B');
    const revalidatedB = createSnapshot('B', 'Brand B Revalidated', 'remote-config');
    const fetchCapabilities = vi.fn().mockResolvedValue(DISABLED_PLATFORM_CAPABILITIES);
    const fetchRevisionA = vi.fn().mockResolvedValue(revisionA);

    const first = renderHook(
      () =>
        useEnterprisePlatformData({
          disableFetch: false,
          enterpriseEnabled: true,
          fetchCapabilities,
          fetchPublicSnapshot: fetchRevisionA,
          initialPublicSnapshot: revisionA,
          serverConfigInit: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(fetchRevisionA).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        Array.from(cache.values()).some(
          (entry) => (entry as { data?: PlatformPublicSnapshot }).data?.brandingRevision === 'A',
        ),
      ).toBe(true),
    );
    first.unmount();

    const remote = deferred<PlatformPublicSnapshot>();
    const fetchRevisionB = vi.fn(() => remote.promise);
    const second = renderHook(
      () =>
        useEnterprisePlatformData({
          disableFetch: false,
          enterpriseEnabled: true,
          fetchCapabilities,
          fetchPublicSnapshot: fetchRevisionB,
          initialPublicSnapshot: revisionB,
          serverConfigInit: true,
        }),
      { wrapper },
    );

    expect(second.result.current.publicSnapshot).toEqual(revisionB);
    expect(second.result.current.publicSnapshot.platformName).toBe('Brand B');
    await waitFor(() => expect(fetchRevisionB).toHaveBeenCalledOnce());

    await act(async () => remote.resolve(revalidatedB));
    await waitFor(() => expect(second.result.current.publicSnapshot).toEqual(revalidatedB));
  });
});
