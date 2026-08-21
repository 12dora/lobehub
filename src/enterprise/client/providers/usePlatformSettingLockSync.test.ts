import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getPlatformSettingLockStatus,
  isPlatformSettingLocked,
  resetPlatformSettingLocks,
} from '@/helpers/platformSettingLocks';

import {
  type PlatformSettingLockSyncParams,
  usePlatformSettingLockSync,
} from './usePlatformSettingLockSync';

const getEffective = vi.hoisted(() => vi.fn());
const mutate = vi.hoisted(() => vi.fn());

vi.mock('../services/userSettings', () => ({
  userSettingsService: { getEffective },
}));

// The scoped mutate is only a cache-writing wrapper here; run the fetcher so the
// prime path is exercised end to end.
vi.mock('@/libs/swr', () => ({
  mutate: (key: unknown, fetcher: () => Promise<unknown>) => {
    mutate(key);
    return Promise.resolve(fetcher());
  },
}));

const APPROVAL_PATH = 'tool.humanIntervention.approvalMode';

const baseParams: PlatformSettingLockSyncParams = {
  capabilitiesReady: true,
  enterpriseEnabled: true,
  isSignedIn: true,
  policyIdentity: 'user-1||1',
  serverConfigInit: true,
  userSettingsPolicyEnabled: true,
};

beforeEach(() => {
  resetPlatformSettingLocks();
  getEffective.mockReset();
  mutate.mockReset();
});

afterEach(() => {
  resetPlatformSettingLocks();
});

describe('usePlatformSettingLockSync', () => {
  it('stays unknown until the server config has hydrated', () => {
    renderHook(() => usePlatformSettingLockSync({ ...baseParams, serverConfigInit: false }));

    expect(getPlatformSettingLockStatus()).toBe('unknown');
    expect(getEffective).not.toHaveBeenCalled();
  });

  it('marks a community / flag-off deployment unmanaged without any request', () => {
    renderHook(() => usePlatformSettingLockSync({ ...baseParams, enterpriseEnabled: false }));

    expect(getPlatformSettingLockStatus()).toBe('disabled');
    expect(getEffective).not.toHaveBeenCalled();
  });

  it('marks an anonymous visitor unmanaged — the query is authenticated', () => {
    renderHook(() => usePlatformSettingLockSync({ ...baseParams, isSignedIn: false }));

    expect(getPlatformSettingLockStatus()).toBe('disabled');
    expect(getEffective).not.toHaveBeenCalled();
  });

  it('stays unknown while capabilities are still loading, so the DISABLED fallback is not trusted', () => {
    renderHook(() =>
      usePlatformSettingLockSync({
        ...baseParams,
        capabilitiesReady: false,
        userSettingsPolicyEnabled: false,
      }),
    );

    expect(getPlatformSettingLockStatus()).toBe('unknown');
    expect(getEffective).not.toHaveBeenCalled();
  });

  it('marks unmanaged once capabilities answer that the policy is off', () => {
    renderHook(() =>
      usePlatformSettingLockSync({ ...baseParams, userSettingsPolicyEnabled: false }),
    );

    expect(getPlatformSettingLockStatus()).toBe('disabled');
  });

  it('primes the mirror from bootstrap when the policy is on', async () => {
    getEffective.mockResolvedValue({ pathMeta: { [APPROVAL_PATH]: { locked: true } } });

    renderHook(() => usePlatformSettingLockSync(baseParams));

    // Fails closed until the answer lands.
    expect(getPlatformSettingLockStatus()).toBe('unknown');

    await waitFor(() => expect(getPlatformSettingLockStatus()).toBe('ready'));
    expect(isPlatformSettingLocked(APPROVAL_PATH)).toBe(true);
    expect(mutate).toHaveBeenCalledWith(['user.settings.effective']);
  });

  it('leaves the mirror unknown when the prime fails', async () => {
    getEffective.mockRejectedValue(new Error('offline'));

    renderHook(() => usePlatformSettingLockSync(baseParams));

    await waitFor(() => expect(getEffective).toHaveBeenCalled());
    expect(getPlatformSettingLockStatus()).toBe('unknown');
  });

  it('re-primes and drops the previous locks when the account changes', async () => {
    getEffective.mockResolvedValue({ pathMeta: { [APPROVAL_PATH]: { locked: true } } });

    const { rerender } = renderHook(
      (params: PlatformSettingLockSyncParams) => usePlatformSettingLockSync(params),
      { initialProps: baseParams },
    );
    await waitFor(() => expect(getPlatformSettingLockStatus()).toBe('ready'));

    getEffective.mockResolvedValue({ pathMeta: { [APPROVAL_PATH]: { locked: false } } });
    rerender({ ...baseParams, policyIdentity: 'user-2||1' });

    await waitFor(() => expect(isPlatformSettingLocked(APPROVAL_PATH)).toBe(false));
    expect(getEffective).toHaveBeenCalledTimes(2);
  });

  it('does not publish a superseded answer after the identity changed', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    getEffective.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    getEffective.mockImplementationOnce(() => new Promise(() => {}));

    const { rerender } = renderHook(
      (params: PlatformSettingLockSyncParams) => usePlatformSettingLockSync(params),
      { initialProps: baseParams },
    );

    rerender({ ...baseParams, policyIdentity: 'user-2||1' });
    resolveFirst({ pathMeta: { [APPROVAL_PATH]: { locked: true } } });

    await waitFor(() => expect(getEffective).toHaveBeenCalledTimes(2));
    expect(getPlatformSettingLockStatus()).toBe('unknown');
    expect(isPlatformSettingLocked(APPROVAL_PATH)).toBe(false);
  });
});
