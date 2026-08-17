// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminInfraSettingsService,
  AdminSystemInfraSettings,
} from '@/enterprise/client/services/adminSystem';

import { useAdminInfraSettings, useInfraDependencyProbe } from './hooks';

const mocks = vi.hoisted(() => ({
  swr: {
    data: undefined as AdminSystemInfraSettings | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
  },
  swrCalls: [] as Array<readonly [string] | null>,
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: readonly [string] | null) => {
    mocks.swrCalls.push(key);
    return mocks.swr;
  },
}));

const service = (
  overrides: Partial<AdminInfraSettingsService> = {},
): AdminInfraSettingsService => ({
  getInfraSettings: vi.fn(),
  testDependency: vi.fn(),
  updateInfraSettings: vi.fn(),
  ...overrides,
});

describe('useAdminInfraSettings', () => {
  beforeEach(() => {
    mocks.swrCalls.length = 0;
  });

  it('skips the request without read permission', () => {
    renderHook(() => useAdminInfraSettings(false, service()));
    expect(mocks.swrCalls.at(-1)).toBeNull();
  });

  it('requests the overview when allowed', () => {
    renderHook(() => useAdminInfraSettings(true, service()));
    expect(mocks.swrCalls.at(-1)).toEqual(['admin.system.getInfraSettings']);
  });
});

describe('useInfraDependencyProbe', () => {
  it('lets independent dependencies probe at the same time', async () => {
    let resolveMail: (value: { checkedAt: Date; latencyMs: number; ok: true }) => void = () =>
      undefined;
    const pendingMail = new Promise<{ checkedAt: Date; latencyMs: number; ok: true }>((resolve) => {
      resolveMail = resolve;
    });
    const testDependency = vi
      .fn()
      .mockImplementationOnce(() => pendingMail)
      .mockResolvedValueOnce({
        checkedAt: new Date('2026-08-17T00:00:01.000Z'),
        latencyMs: 9,
        ok: true,
      });
    const { result } = renderHook(() => useInfraDependencyProbe(service({ testDependency })));

    act(() => {
      void result.current.run('mail');
    });
    await act(async () => {
      await result.current.run('objectStorage');
    });
    expect(testDependency).toHaveBeenCalledTimes(2);
    expect(result.current.busy).toMatchObject({ mail: true, objectStorage: false });

    await act(async () => {
      resolveMail({ checkedAt: new Date('2026-08-17T00:00:00.000Z'), latencyMs: 18, ok: true });
      await pendingMail;
    });
    expect(result.current.busy.mail).toBe(false);
    expect(result.current.results.mail).toMatchObject({ ok: true });
    expect(result.current.results.objectStorage).toMatchObject({ ok: true });
  });

  it('ignores a second click on the same dependency while it is in flight', async () => {
    let resolveProbe: (value: { checkedAt: Date; latencyMs: number; ok: true }) => void = () =>
      undefined;
    const pending = new Promise<{ checkedAt: Date; latencyMs: number; ok: true }>((resolve) => {
      resolveProbe = resolve;
    });
    const testDependency = vi.fn().mockReturnValue(pending);
    const { result } = renderHook(() => useInfraDependencyProbe(service({ testDependency })));

    act(() => {
      void result.current.run('mail');
    });
    await act(async () => {
      await result.current.run('mail');
    });
    expect(testDependency).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveProbe({ checkedAt: new Date('2026-08-17T00:00:00.000Z'), latencyMs: 18, ok: true });
      await pending;
    });
  });

  it('stores an unreachable result when the mutation throws', async () => {
    const { result } = renderHook(() =>
      useInfraDependencyProbe(
        service({ testDependency: vi.fn().mockRejectedValue(new Error('network')) }),
      ),
    );

    await act(async () => {
      await result.current.run('objectStorage');
    });
    expect(result.current.results.objectStorage).toMatchObject({
      message: 'unreachable',
      ok: false,
    });
  });
});
