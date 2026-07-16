// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFetchAdminManagedResources } from './useAdminManagedResources';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  swr: vi.fn((key: unknown, fetcher: () => unknown) => {
    if (key) void fetcher();
    return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
  }),
}));

vi.mock('@/enterprise/client/services/adminManagedResources', () => ({
  adminManagedResourcesService: { get: mocks.get },
}));

vi.mock('@/libs/swr', () => ({ useClientDataSWR: mocks.swr }));

describe('useFetchAdminManagedResources permission gate', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.swr.mockClear();
  });

  it('issues no request without policy read permission', () => {
    renderHook(() => useFetchAdminManagedResources(false));
    expect(mocks.swr.mock.calls[0]?.[0]).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('uses the stable SWR key when policy read is allowed', () => {
    renderHook(() => useFetchAdminManagedResources(true));
    expect(mocks.swr.mock.calls[0]?.[0]).toEqual(['admin.managedResources.get']);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});
