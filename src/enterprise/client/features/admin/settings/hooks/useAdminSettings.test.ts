// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFetchAdminSettingsDraft } from './useAdminSettings';

const mocks = vi.hoisted(() => ({
  capability: false,
  getDraft: vi.fn(),
  swr: vi.fn((key: unknown, fetcher: () => unknown) => {
    if (key) void fetcher();
    return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
  }),
}));

vi.mock('@/enterprise/client/providers/EnterprisePlatformProvider', () => ({
  useEnterprisePlatform: () => ({
    capabilities: { userSettingsPolicyEnabled: mocks.capability },
  }),
}));

vi.mock('@/enterprise/client/services/adminSettings', () => ({
  adminSettingsService: { getDraft: mocks.getDraft },
}));

vi.mock('@/libs/swr', () => ({ useClientDataSWR: mocks.swr }));

describe('useFetchAdminSettingsDraft capability gate', () => {
  beforeEach(() => {
    mocks.capability = false;
    mocks.getDraft.mockReset();
    mocks.swr.mockClear();
  });

  it('uses a null SWR key and makes zero service calls when the capability is off', () => {
    renderHook(() => useFetchAdminSettingsDraft(true));
    expect(mocks.swr.mock.calls[0]?.[0]).toBeNull();
    expect(mocks.getDraft).not.toHaveBeenCalled();
  });

  it('fetches only when both the capability and caller gate are enabled', () => {
    mocks.capability = true;
    const { rerender } = renderHook(({ enabled }) => useFetchAdminSettingsDraft(enabled), {
      initialProps: { enabled: false },
    });
    expect(mocks.swr.mock.calls.at(-1)?.[0]).toBeNull();
    expect(mocks.getDraft).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(mocks.swr.mock.calls.at(-1)?.[0]).toEqual(['admin.settings.draft']);
    expect(mocks.getDraft).toHaveBeenCalledTimes(1);
  });
});
