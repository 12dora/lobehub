/**
 * @vitest-environment happy-dom
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SIDEBAR_LAYOUT_POLICY } from '@/types/platform/sidebarLayout';

const fetchMock = vi.fn();
const useClientDataSWRMock = vi.fn();

vi.mock('@/enterprise/client/services/platform', () => ({
  fetchPlatformSidebarLayoutPolicy: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (...args: unknown[]) => useClientDataSWRMock(...args),
}));

const serverConfigState = {
  platformAdmin: false as boolean,
  serverConfigInit: true,
};

type ServerConfigStoreSlice = {
  serverConfig: {
    enterprise: {
      enabled: boolean;
      platformAdmin: boolean;
    };
  };
  serverConfigInit: boolean;
};

vi.mock('@/store/serverConfig', () => ({
  useServerConfigStore: (selector: (s: ServerConfigStoreSlice) => unknown) =>
    selector({
      serverConfig: {
        enterprise: {
          enabled: serverConfigState.platformAdmin,
          platformAdmin: serverConfigState.platformAdmin,
        },
      },
      serverConfigInit: serverConfigState.serverConfigInit,
    }),
}));

describe('useSidebarLayoutPolicy', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useClientDataSWRMock.mockReset();
    useClientDataSWRMock.mockReturnValue({ data: undefined });
    serverConfigState.platformAdmin = false;
    serverConfigState.serverConfigInit = true;
  });

  it('flag off: zero policy RPCs and user-controlled default', async () => {
    const { useSidebarLayoutPolicy } = await import('./useSidebarLayoutPolicy');
    const { result } = renderHook(() => useSidebarLayoutPolicy());

    expect(result.current).toEqual(DEFAULT_SIDEBAR_LAYOUT_POLICY);
    expect(useClientDataSWRMock).toHaveBeenCalled();
    const [key] = useClientDataSWRMock.mock.calls[0];
    expect(key).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flag on: SWR key enables the policy fetch', async () => {
    serverConfigState.platformAdmin = true;
    const { useSidebarLayoutPolicy, SIDEBAR_LAYOUT_POLICY_KEY } =
      await import('./useSidebarLayoutPolicy');
    renderHook(() => useSidebarLayoutPolicy());

    const [key] = useClientDataSWRMock.mock.calls[0];
    expect(key).toEqual([SIDEBAR_LAYOUT_POLICY_KEY]);
  });
});
