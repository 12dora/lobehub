/**
 * @vitest-environment happy-dom
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMyAccessMock = vi.fn();
const useClientDataSWRMock = vi.fn();

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      auth: {
        getMyAccess: {
          query: (...args: unknown[]) => getMyAccessMock(...args),
        },
      },
    },
  },
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (...args: unknown[]) => useClientDataSWRMock(...args),
}));

const serverConfigState = { platformAdmin: true, serverConfigInit: true };

vi.mock('@/store/serverConfig', () => ({
  useServerConfigStore: (
    selector: (s: {
      serverConfig: { enterprise: { platformAdmin: boolean } };
      serverConfigInit: boolean;
    }) => unknown,
  ) =>
    selector({
      serverConfig: { enterprise: { platformAdmin: serverConfigState.platformAdmin } },
      serverConfigInit: serverConfigState.serverConfigInit,
    }),
}));

const userState = { isSignedIn: true as boolean };

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (s: { isSignedIn: boolean }) => unknown) => selector(userState),
}));

describe('useHasAdminEntry', () => {
  beforeEach(() => {
    getMyAccessMock.mockReset();
    useClientDataSWRMock.mockReset();
    useClientDataSWRMock.mockReturnValue({ data: undefined });
    serverConfigState.platformAdmin = true;
    serverConfigState.serverConfigInit = true;
    userState.isSignedIn = true;
  });

  it('anonymous user: no request and no entry', async () => {
    userState.isSignedIn = false;
    const { useHasAdminEntry } = await import('./useHasAdminEntry');

    const { result } = renderHook(() => useHasAdminEntry());

    expect(result.current).toBe(false);
    expect(useClientDataSWRMock.mock.calls[0][0]).toBeNull();
    expect(getMyAccessMock).not.toHaveBeenCalled();
  });

  it('platform admin feature off: no request and no entry', async () => {
    serverConfigState.platformAdmin = false;
    const { useHasAdminEntry } = await import('./useHasAdminEntry');

    const { result } = renderHook(() => useHasAdminEntry());

    expect(result.current).toBe(false);
    expect(useClientDataSWRMock.mock.calls[0][0]).toBeNull();
    expect(getMyAccessMock).not.toHaveBeenCalled();
  });

  it('server config not hydrated: no request', async () => {
    serverConfigState.serverConfigInit = false;
    const { useHasAdminEntry } = await import('./useHasAdminEntry');

    renderHook(() => useHasAdminEntry());

    expect(useClientDataSWRMock.mock.calls[0][0]).toBeNull();
  });

  it('enabled: queries the access snapshot with a cached, non-retrying key', async () => {
    const { ADMIN_ENTRY_ACCESS_KEY, useHasAdminEntry } = await import('./useHasAdminEntry');

    renderHook(() => useHasAdminEntry());

    const [key, , config] = useClientDataSWRMock.mock.calls[0];
    expect(key).toEqual([ADMIN_ENTRY_ACCESS_KEY]);
    expect(config).toMatchObject({ revalidateOnFocus: false, shouldRetryOnError: false });
  });

  it('stays false while the snapshot is unknown (no flash for non-admins)', async () => {
    const { useHasAdminEntry } = await import('./useHasAdminEntry');

    const { result } = renderHook(() => useHasAdminEntry());

    expect(result.current).toBe(false);
  });

  it('stays false for an authenticated user without admin access', async () => {
    useClientDataSWRMock.mockReturnValue({ data: { hasAdminAccess: false } });
    const { useHasAdminEntry } = await import('./useHasAdminEntry');

    const { result } = renderHook(() => useHasAdminEntry());

    expect(result.current).toBe(false);
  });

  it('is true for a user with admin access', async () => {
    useClientDataSWRMock.mockReturnValue({ data: { hasAdminAccess: true } });
    const { useHasAdminEntry } = await import('./useHasAdminEntry');

    const { result } = renderHook(() => useHasAdminEntry());

    expect(result.current).toBe(true);
  });
});
