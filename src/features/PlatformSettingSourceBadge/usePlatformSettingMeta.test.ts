import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as enterprisePlatformModule from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { userSettingsService } from '@/enterprise/client/services/userSettings';
import * as swrModule from '@/libs/swr';
import type { UserSettingsGetEffectiveOutput } from '@/server/enterprise/contracts/userSettings';
import { useUserStore } from '@/store/user';
import { DISABLED_PLATFORM_CAPABILITIES } from '@/types/platform/capabilities';
import { DISABLED_PLATFORM_PUBLIC_SNAPSHOT } from '@/types/platform/publicSnapshot';

import { usePlatformSettingMeta } from './usePlatformSettingMeta';

const PATH = 'general.telemetry';

const effectiveData = (overrides?: {
  hidden?: boolean;
  locked?: boolean;
  mode?: 'default' | 'locked' | 'user';
  source?: 'builtin' | 'environment' | 'legacy' | 'platform' | 'user';
}): UserSettingsGetEffectiveOutput => ({
  effectiveSettings: {},
  effectiveValues: { [PATH]: true },
  pathMeta: {
    [PATH]: {
      canOverride: true,
      hidden: overrides?.hidden ?? false,
      locked: overrides?.locked ?? false,
      mode: overrides?.mode ?? 'default',
      path: PATH,
      schemaVersion: 1,
      source: overrides?.source ?? 'user',
      visibility: overrides?.hidden ? 'hidden' : 'visible',
    },
  },
  platformRevision: 2,
  registryVersion: 1,
  userOverrideRevision: 3,
});

const deferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const initialUserStoreState = useUserStore.getState();

describe('usePlatformSettingMeta', () => {
  const revalidate = vi.fn();
  const refreshUserState = vi.fn();
  let useClientDataSWR: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    useClientDataSWR = vi.spyOn(swrModule, 'useClientDataSWR');
    useUserStore.setState({ refreshUserState });
    vi.spyOn(enterprisePlatformModule, 'useEnterprisePlatform').mockReturnValue({
      capabilities: {
        ...DISABLED_PLATFORM_CAPABILITIES,
        userSettingsPolicyEnabled: true,
      },
      error: null,
      loading: false,
      publicSnapshot: DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
      refresh: vi.fn(),
    });
    useClientDataSWR.mockReturnValue({
      data: effectiveData(),
      error: undefined,
      isLoading: false,
      mutate: revalidate,
    } as never);
    revalidate.mockResolvedValue(effectiveData());
    refreshUserState.mockResolvedValue(undefined);
  });

  afterEach(() => {
    useUserStore.setState(initialUserStoreState, true);
    vi.restoreAllMocks();
  });

  it('uses a null SWR key and exact unmanaged state when the feature is off', () => {
    vi.spyOn(enterprisePlatformModule, 'useEnterprisePlatform').mockReturnValue({
      capabilities: DISABLED_PLATFORM_CAPABILITIES,
      error: null,
      loading: false,
      publicSnapshot: DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
      refresh: vi.fn(),
    });
    const getEffective = vi.spyOn(userSettingsService, 'getEffective');

    const { result } = renderHook(() => usePlatformSettingMeta(PATH));

    expect(useClientDataSWR).toHaveBeenCalledWith(null, expect.any(Function));
    expect(getEffective).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      enabled: false,
      hidden: false,
      locked: false,
      status: 'disabled',
    });
  });

  it.each([
    ['loading', { data: undefined, error: undefined, isLoading: true }],
    ['error', { data: undefined, error: new Error('offline'), isLoading: false }],
  ] as const)('keeps the row visible but fail-closes writes for %s', (status, swrState) => {
    useClientDataSWR.mockReturnValue({ ...swrState, mutate: revalidate } as never);

    const { result } = renderHook(() => usePlatformSettingMeta(PATH));

    expect(result.current).toMatchObject({ hidden: false, locked: true, status });
  });

  it('derives hidden and locked from settled effective metadata', () => {
    useClientDataSWR.mockReturnValue({
      data: effectiveData({ hidden: true, locked: true, mode: 'locked', source: 'platform' }),
      error: undefined,
      isLoading: false,
      mutate: revalidate,
    } as never);

    const { result } = renderHook(() => usePlatformSettingMeta(PATH));

    expect(result.current).toMatchObject({ hidden: true, locked: true, status: 'ready' });
  });

  it.each([
    ['own override on a platform default', { mode: 'default', source: 'user' }, true, false],
    ['platform default still in effect', { mode: 'default', source: 'platform' }, false, false],
    ['locked policy', { mode: 'locked', locked: true, source: 'platform' }, false, true],
    ['unmanaged path', { mode: 'user', source: 'user' }, false, false],
  ] as const)('offers the reset affordance only for %s', (_case, overrides, canReset, locked) => {
    useClientDataSWR.mockReturnValue({
      data: effectiveData(overrides),
      error: undefined,
      isLoading: false,
      mutate: revalidate,
    } as never);

    const { result } = renderHook(() => usePlatformSettingMeta(PATH));

    expect(result.current).toMatchObject({ canReset, locked, status: 'ready' });
  });

  it('single-flights reset and refreshes effective metadata plus the real user store', async () => {
    const pendingReset = deferred<{ deleted: boolean; path: string; revision: number }>();
    const resetOverride = vi
      .spyOn(userSettingsService, 'resetOverride')
      .mockReturnValue(pendingReset.promise);
    const { result } = renderHook(() => usePlatformSettingMeta(PATH));

    let first!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    act(() => {
      first = result.current.reset();
      duplicate = result.current.reset();
    });

    expect(resetOverride).toHaveBeenCalledTimes(1);
    await expect(duplicate).resolves.toBe(false);

    await act(async () => {
      pendingReset.resolve({ deleted: true, path: PATH, revision: 4 });
      await expect(first).resolves.toBe(true);
    });

    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(refreshUserState).toHaveBeenCalledTimes(1);
    expect(result.current.resetting).toBe(false);
  });

  it('maps reset rejection to hook state without an unhandled rejection and supports retry', async () => {
    const resetOverride = vi
      .spyOn(userSettingsService, 'resetOverride')
      .mockRejectedValueOnce(new Error('internal details'))
      .mockResolvedValueOnce({ deleted: true, path: PATH, revision: 5 });
    const { result } = renderHook(() => usePlatformSettingMeta(PATH));

    await act(async () => {
      await expect(result.current.reset()).resolves.toBe(false);
    });
    expect(result.current.resetError).toBeInstanceOf(Error);
    expect(revalidate).not.toHaveBeenCalled();
    expect(refreshUserState).not.toHaveBeenCalled();

    await act(async () => {
      await expect(result.current.reset()).resolves.toBe(true);
    });
    await waitFor(() => expect(result.current.resetError).toBeNull());
    expect(resetOverride).toHaveBeenCalledTimes(2);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(refreshUserState).toHaveBeenCalledTimes(1);
  });

  it('retries a metadata load through the owning SWR response', async () => {
    useClientDataSWR.mockReturnValue({
      data: undefined,
      error: new Error('offline'),
      isLoading: false,
      mutate: revalidate,
    } as never);
    const { result } = renderHook(() => usePlatformSettingMeta(PATH));

    await act(async () => {
      await result.current.retry();
    });

    expect(revalidate).toHaveBeenCalledTimes(1);
  });
});
