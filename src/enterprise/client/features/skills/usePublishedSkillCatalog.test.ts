// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useToolStore } from '@/store/tool';

import {
  PLATFORM_PUBLISHED_SKILL_CATALOG_KEY,
  usePublishedSkillCatalog,
} from './usePublishedSkillCatalog';

const mocks = vi.hoisted(() => ({
  fetchers: [] as Array<() => Promise<unknown>>,
  getPublishedCatalog: vi.fn(),
  swr: vi.fn((key: unknown, fetcher: () => Promise<unknown>) => {
    if (key) mocks.fetchers.push(fetcher);
    return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
  }),
}));

vi.mock('../../services/platformSkills', () => ({
  platformSkillsService: { getPublishedCatalog: mocks.getPublishedCatalog },
}));

vi.mock('@/libs/swr', () => ({ useClientDataSWR: mocks.swr }));

const deferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const catalog = (revision: string, skillKey = 'approved.skill') => ({
  revision,
  skills: [
    {
      checksum: 'a'.repeat(64),
      description: null,
      displayName: skillKey,
      distribution: 'default' as const,
      skillKey,
      source: 'uploaded' as const,
      version: '1.0.0',
    },
  ],
});

describe('usePublishedSkillCatalog', () => {
  beforeEach(() => {
    mocks.fetchers.length = 0;
    mocks.getPublishedCatalog.mockReset();
    mocks.swr.mockClear();
    useToolStore.setState({
      platformSkillCatalog: null,
      platformSkillCatalogInvalidationRevision: '0',
      platformSkillCatalogRequestEpoch: 0,
      platformSkillRuntimeEnforced: false,
      platformSkillRuntimeStatus: 'unmanaged',
    });
  });

  it('does not call platform.skills when managed mode is disabled', () => {
    renderHook(() => usePublishedSkillCatalog(false));
    expect(mocks.swr.mock.calls[0]?.[0]).toBeNull();
    expect(mocks.fetchers).toHaveLength(0);
    expect(mocks.getPublishedCatalog).not.toHaveBeenCalled();
  });

  it('keys the catalog by config and invalidation revisions', async () => {
    useToolStore.setState({ platformSkillCatalogInvalidationRevision: 'catalog-9' });
    mocks.getPublishedCatalog.mockResolvedValue(catalog('catalog-9'));

    renderHook(() => usePublishedSkillCatalog(true, 'config-7'));

    expect(mocks.swr.mock.calls[0]?.[0]).toEqual([
      PLATFORM_PUBLISHED_SKILL_CATALOG_KEY,
      'config-7',
      'catalog-9',
    ]);
    await mocks.fetchers[0]();
    expect(useToolStore.getState().platformSkillCatalog?.revision).toBe('catalog-9');
  });

  it('ignores a stale response when a newer request epoch has completed', async () => {
    useToolStore.setState({
      platformSkillRuntimeEnforced: true,
      platformSkillRuntimeStatus: 'loading',
    });
    const first = deferred<ReturnType<typeof catalog>>();
    const second = deferred<ReturnType<typeof catalog>>();
    mocks.getPublishedCatalog
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderHook(() => usePublishedSkillCatalog(true));
    const fetcher = mocks.fetchers[0];

    const firstRequest = fetcher();
    const secondRequest = fetcher();
    second.resolve(catalog('catalog-2', 'second.skill'));
    await secondRequest;
    first.resolve(catalog('catalog-1', 'first.skill'));
    await firstRequest;

    const state = useToolStore.getState();
    expect(state.platformSkillCatalog?.revision).toBe('catalog-2');
    expect(state.platformSkillCatalog?.skills[0]?.skillKey).toBe('second.skill');
    expect(state.platformSkillCatalogRequestEpoch).toBe(2);
    expect(state.platformSkillRuntimeStatus).toBe('ready');
  });

  it('moves an enforced catalog to error on fetch failure', async () => {
    useToolStore.setState({
      platformSkillRuntimeEnforced: true,
      platformSkillRuntimeStatus: 'loading',
    });
    mocks.getPublishedCatalog.mockRejectedValue(new Error('offline'));
    renderHook(() => usePublishedSkillCatalog(true));

    await expect(mocks.fetchers[0]()).rejects.toThrow('offline');

    expect(useToolStore.getState().platformSkillCatalog).toBeNull();
    expect(useToolStore.getState().platformSkillRuntimeStatus).toBe('error');
  });

  it('keeps an enforced empty catalog fail-closed', async () => {
    useToolStore.setState({
      platformSkillRuntimeEnforced: true,
      platformSkillRuntimeStatus: 'loading',
    });
    mocks.getPublishedCatalog.mockResolvedValue({ revision: 'catalog-empty', skills: [] });
    renderHook(() => usePublishedSkillCatalog(true));

    await mocks.fetchers[0]();

    expect(useToolStore.getState().platformSkillCatalog?.skills).toEqual([]);
    expect(useToolStore.getState().platformSkillRuntimeStatus).toBe('error');
  });
});
