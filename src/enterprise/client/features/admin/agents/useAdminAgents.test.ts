// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockAdminAgentsClient } from './__tests__/mockAdminAgents';
import {
  fetchActiveAdminAgentRollouts,
  fetchAdminAgentDetail,
  fetchPublishedAdminAgentReplacements,
  findDefaultAdminAgent,
  mergePolledRollouts,
  selectActiveRolloutJobIds,
  useFetchAdminAgent,
} from './useAdminAgents';

const mocks = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  fetchers: [] as (() => Promise<unknown>)[],
  keys: [] as unknown[],
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown, fetcher: () => Promise<unknown>, config = {}) => {
    mocks.keys.push(key);
    mocks.fetchers.push(fetcher);
    mocks.configs.push(config);
    return { data: undefined, error: undefined, isLoading: true, mutate: vi.fn() };
  },
  useClientPollingSWR: (key: unknown, fetcher: () => Promise<unknown>, config = {}) => {
    mocks.keys.push(key);
    mocks.fetchers.push(fetcher);
    mocks.configs.push(config);
    return { data: undefined, error: undefined, isLoading: true, mutate: vi.fn() };
  },
}));

describe('Admin Agent hook adapter injection', () => {
  beforeEach(() => {
    mocks.configs.length = 0;
    mocks.fetchers.length = 0;
    mocks.keys.length = 0;
  });

  it('keeps disabled detail reads null and never invokes the injected client', () => {
    const client = createMockAdminAgentsClient();
    const get = vi.spyOn(client, 'get');
    renderHook(() => useFetchAdminAgent('agent-1', false, client));
    expect(mocks.keys).toEqual([null, null]);
    expect(get).not.toHaveBeenCalled();
  });

  it('runs the detail aggregate through the injected client boundary', async () => {
    const client = createMockAdminAgentsClient();
    const get = vi.spyOn(client, 'get');
    const assignments = vi.spyOn(client, 'listAssignments');
    const rollouts = vi.spyOn(client, 'listRollouts');
    const versions = vi.spyOn(client, 'listVersions');
    renderHook(() => useFetchAdminAgent('agent-inbox', true, client));
    const detail = await mocks.fetchers[0]!();
    expect(get).toHaveBeenCalledWith({ id: 'agent-inbox' });
    expect(assignments).toHaveBeenCalledWith({
      agentId: 'agent-inbox',
      limit: 100,
    });
    expect(rollouts).toHaveBeenCalledWith({
      agentId: 'agent-inbox',
      limit: 100,
    });
    expect(versions).toHaveBeenCalledWith({
      agentId: 'agent-inbox',
      limit: 100,
    });
    expect((detail as { versions: unknown[] }).versions).toHaveLength(1);
    expect(mocks.configs[0]!.keepPreviousData).toBe(false);
    expect(mocks.configs[0]!.refreshInterval).toBeUndefined();
    expect(mocks.keys[1]).toBeNull();
  });

  it('dedupes active jobs and merges list-status poll projections without a silent 20-job slice', async () => {
    const client = createMockAdminAgentsClient();
    const detail = await fetchAdminAgentDetail('agent-inbox', client);
    const running = detail.rollouts[0]!;
    const jobs = Array.from({ length: 21 }, (_, index) => ({
      ...running,
      jobId: `rollout-active-${index}`,
    }));
    const manyActive = { ...detail, rollouts: jobs };
    // No silent cap — every loaded active job is in the poll key.
    expect(selectActiveRolloutJobIds(manyActive)).toHaveLength(21);

    const listRollouts = vi.spyOn(client, 'listRollouts').mockResolvedValue({
      items: jobs.map((job) => ({ ...job, completed: job.completed + 1 })),
      nextCursor: null,
    });
    const getRollout = vi.spyOn(client, 'getRollout');
    const polled = await fetchActiveAdminAgentRollouts(
      detail.identity.id,
      selectActiveRolloutJobIds(manyActive),
      client,
    );
    // Prefer one list walk over N×getRollout when the list covers the active set.
    // Active poll must request only pending/running so completed history is not transferred.
    expect(listRollouts).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: detail.identity.id,
        status: ['pending', 'running'],
      }),
    );
    expect(getRollout).not.toHaveBeenCalled();
    expect(polled).toHaveLength(21);
    const merged = mergePolledRollouts(manyActive, polled);
    expect(merged.rollouts.every((row) => row.completed === running.completed + 1)).toBe(true);
    expect(detail.rollouts[0]!.completed).toBe(running.completed);
  });

  it('loads only the first collection page and preserves its next cursor for load-more', async () => {
    const client = createMockAdminAgentsClient();
    const version = (await client.listVersions({ agentId: 'agent-inbox' })).items[0]!;
    const listVersions = vi.spyOn(client, 'listVersions').mockResolvedValueOnce({
      items: [{ ...version, id: 'version-page-1' }],
      nextCursor: 'still-more',
    });

    const detail = await fetchAdminAgentDetail('agent-inbox', client);
    expect(detail.collectionMeta?.versionsTruncated).toBe(true);
    expect(detail.collectionMeta?.versionsNextCursor).toBe('still-more');
    expect(detail.versions).toHaveLength(1);
    expect(listVersions).toHaveBeenCalledTimes(1);
  });

  it('skips rollout reads when the authoritative platform capability is off', async () => {
    const base = createMockAdminAgentsClient();
    const listRollouts = vi.spyOn(base, 'listRollouts');

    const detail = await fetchAdminAgentDetail('agent-inbox', base, false);

    expect(listRollouts).not.toHaveBeenCalled();
    expect(detail.rollouts).toEqual([]);
    expect(detail.versions.length).toBeGreaterThan(0);
  });

  it('sorts the bounded version page without following its opaque cursor', async () => {
    const client = createMockAdminAgentsClient();
    const version = (await client.listVersions({ agentId: 'agent-inbox' })).items[0]!;
    const listVersions = vi.spyOn(client, 'listVersions').mockResolvedValueOnce({
      // Older page-1 row first in opaque cursor order — aggregate must re-sort by createdAt.
      items: [
        { ...version, createdAt: new Date('2026-07-16T06:00:00.000Z'), id: 'version-inbox-1' },
        {
          ...version,
          createdAt: new Date('2026-07-17T06:00:00.000Z'),
          id: 'version-inbox-2',
          version: '1.0.1',
        },
      ],
      nextCursor: 'next-page',
    });

    const detail = await fetchAdminAgentDetail('agent-inbox', client);

    // Canonical aggregate order: newest createdAt first (not opaque page/id order).
    expect(detail.versions.map(({ id }) => id)).toEqual(['version-inbox-2', 'version-inbox-1']);
    expect(listVersions).toHaveBeenCalledTimes(1);
    expect(listVersions).toHaveBeenCalledWith({ agentId: 'agent-inbox', limit: 100 });
    expect(detail.collectionMeta?.versionsNextCursor).toBe('next-page');
  });

  it('resolves the default inbox via a dedicated isDefault list filter (no catalog drain)', async () => {
    const client = createMockAdminAgentsClient();
    const list = vi.spyOn(client, 'list');

    const found = await findDefaultAdminAgent(client);
    expect(found?.identity.isDefault).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ isDefault: true, limit: 1 });
  });

  it('loads one published replacement page without multi-page drain', async () => {
    const client = createMockAdminAgentsClient();
    const list = vi.spyOn(client, 'list');

    const items = await fetchPublishedAdminAgentReplacements('agent-inbox', client, {
      limit: 50,
      query: 'research',
    });
    expect(items.every(({ identity }) => identity.id !== 'agent-inbox')).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({
      limit: 50,
      query: 'research',
      status: 'published',
    });
  });
});
