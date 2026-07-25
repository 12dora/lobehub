// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_AGENT_DEP_COLLECTION_PAGE_LIMIT,
  useAdminConnectorDetails,
  useAdminPublishedConnectors,
  useAdminPublishedProviders,
} from './useDependencyCatalog';

const swr = vi.hoisted(() => ({
  fetcher: undefined as undefined | (() => Promise<unknown>),
  key: undefined as unknown,
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown, fetcher: () => Promise<unknown>) => {
    swr.key = key;
    swr.fetcher = key ? fetcher : undefined;
    return {
      data: undefined,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    };
  },
}));
// These service modules pull lambdaClient at import time; stub them (the hook uses an injected fake).
vi.mock('@/enterprise/client/services/adminAiCatalog', () => ({ adminAiCatalogService: {} }));
vi.mock('@/enterprise/client/services/adminConnectors', () => ({ adminConnectorsService: {} }));
vi.mock('@/enterprise/client/services/platformSkills', () => ({ platformSkillsService: {} }));

const batchItem = (id: string) => ({
  connectorId: id,
  published: {
    connectorId: id,
    connectorKey: `key-${id}`,
    publishedChecksum: 'a'.repeat(64),
    publishedRevision: 2,
    tools: [{ platformPolicy: 'allow', toolKey: 'search' }],
  },
});

describe('useAdminConnectorDetails uses a bounded batch read (no N+1)', () => {
  beforeEach(() => {
    swr.fetcher = undefined;
    swr.key = undefined;
  });

  it('issues ONE getPublishedBatch request for up to 100 refs (never a per-connector get)', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `c${String(i).padStart(3, '0')}`);
    const service = {
      get: vi.fn(),
      getPublishedBatch: vi.fn().mockResolvedValue({ items: ids.map(batchItem) }),
      list: vi.fn(),
    };
    renderHook(() => useAdminConnectorDetails(ids, service as never));

    const result = await swr.fetcher!();

    expect(service.getPublishedBatch).toHaveBeenCalledTimes(1);
    expect(service.getPublishedBatch).toHaveBeenCalledWith({ ids });
    expect(service.get).not.toHaveBeenCalled(); // no N+1 per-connector reads
    expect(Object.keys(result as object)).toHaveLength(100);
  });

  it('maps each batch item to the exact connector detail tuple (null for unpublished)', async () => {
    const service = {
      get: vi.fn(),
      getPublishedBatch: vi.fn().mockResolvedValue({
        items: [batchItem('c1'), { connectorId: 'c2', published: null }],
      }),
      list: vi.fn(),
    };
    renderHook(() => useAdminConnectorDetails(['c1', 'c2'], service as never));
    const result = (await swr.fetcher!()) as Record<string, unknown>;

    expect(result.c1).toEqual({
      connectorId: 'c1',
      connectorKey: 'key-c1',
      publishedChecksum: 'a'.repeat(64),
      publishedRevision: 2,
      tools: [{ platformPolicy: 'allow', toolKey: 'search' }],
    });
    expect(result.c2).toBeNull();
  });

  it('does not fetch at all when there are no connector refs', () => {
    const service = { get: vi.fn(), getPublishedBatch: vi.fn(), list: vi.fn() };
    renderHook(() => useAdminConnectorDetails([], service as never));
    expect(swr.key).toBeNull();
    expect(swr.fetcher).toBeUndefined();
  });
});

describe('dependency catalog pickers use server-side one-page search', () => {
  beforeEach(() => {
    swr.fetcher = undefined;
    swr.key = undefined;
  });

  it('loads one provider page with query and reports truncation when nextCursor remains', async () => {
    const listProviders = vi.fn().mockResolvedValue({
      items: [{ displayName: 'P', id: 'p1', providerKey: 'p', status: 'published' }],
      nextCursor: 'more',
    });
    renderHook(() =>
      useAdminPublishedProviders(true, 'openai', {
        getProvider: vi.fn(),
        listProviderRevisions: vi.fn(),
        listProviders,
      } as never),
    );

    const page = (await swr.fetcher!()) as { items: unknown[]; truncated: boolean };
    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(listProviders).toHaveBeenCalledWith({
      limit: 100,
      query: 'openai',
      status: 'published',
    });
    expect(page.items).toHaveLength(1);
    expect(page.truncated).toBe(true);
    expect(swr.key).toEqual(['enterprise.admin.agents.dep.providers', 'openai']);
  });

  it('loads one connector page with query and reports truncation when nextCursor remains', async () => {
    const list = vi.fn().mockResolvedValue({
      items: [{ displayName: 'C', id: 'c1', key: 'c', status: 'published' }],
      nextCursor: 'more',
    });
    renderHook(() =>
      useAdminPublishedConnectors(true, 'issues', {
        get: vi.fn(),
        getPublishedBatch: vi.fn(),
        list,
      } as never),
    );

    const page = (await swr.fetcher!()) as { items: unknown[]; truncated: boolean };
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({
      limit: 100,
      query: 'issues',
      status: 'published',
    });
    expect(page.truncated).toBe(true);
    expect(swr.key).toEqual(['enterprise.admin.agents.dep.connectors', 'issues']);
  });
});

// Keep the page-limit constant exported for revision history drains.
void ADMIN_AGENT_DEP_COLLECTION_PAGE_LIMIT;
