// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PLATFORM_PUBLISHED_SKILL_CATALOG_KEY,
  usePublishedSkillCatalog,
} from './usePublishedSkillCatalog';

const mocks = vi.hoisted(() => ({
  getPublishedCatalog: vi.fn(),
  swr: vi.fn((key: unknown, fetcher: () => unknown) => {
    if (key) void fetcher();
    return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
  }),
}));

vi.mock('../../services/platformSkills', () => ({
  platformSkillsService: { getPublishedCatalog: mocks.getPublishedCatalog },
}));

vi.mock('@/libs/swr', () => ({ useClientDataSWR: mocks.swr }));

describe('usePublishedSkillCatalog', () => {
  beforeEach(() => {
    mocks.getPublishedCatalog.mockReset();
    mocks.swr.mockClear();
  });

  it('does not call platform.skills when managed mode is disabled', () => {
    renderHook(() => usePublishedSkillCatalog(false));
    expect(mocks.swr.mock.calls[0]?.[0]).toBeNull();
    expect(mocks.getPublishedCatalog).not.toHaveBeenCalled();
  });

  it('uses the stable public catalog key in managed mode', () => {
    renderHook(() => usePublishedSkillCatalog(true));
    expect(mocks.swr.mock.calls[0]?.[0]).toEqual([PLATFORM_PUBLISHED_SKILL_CATALOG_KEY]);
    expect(mocks.getPublishedCatalog).toHaveBeenCalledTimes(1);
  });
});
