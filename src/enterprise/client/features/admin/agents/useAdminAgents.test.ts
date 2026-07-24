// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockAdminAgentsClient } from './__tests__/mockAdminAgents';
import {
  ADMIN_AGENT_COLLECTION_PAGE_LIMIT,
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
      cursor: undefined,
      limit: 100,
    });
    expect(rollouts).toHaveBeenCalledWith({
      agentId: 'agent-inbox',
      cursor: undefined,
      limit: 100,
    });
    expect(versions).toHaveBeenCalledWith({
      agentId: 'agent-inbox',
      cursor: undefined,
      limit: 100,
    });
    expect((detail as { versions: unknown[] }).versions).toHaveLength(1);
    expect(mocks.configs[0]!.keepPreviousData).toBe(false);
    expect(mocks.configs[0]!.refreshInterval).toBeUndefined();
    expect(mocks.keys[1]).toBeNull();
  });

  it('dedupes active jobs and merges lightweight getRollout projections', async () => {
    const client = createMockAdminAgentsClient();
    const detail = await fetchAdminAgentDetail('agent-inbox', client);
    const running = detail.rollouts[0]!;
    const duplicateDetail = { ...detail, rollouts: [running, running] };
    expect(selectActiveRolloutJobIds(duplicateDetail)).toEqual([running.jobId]);

    const getRollout = vi.spyOn(client, 'getRollout');
    const polled = await fetchActiveAdminAgentRollouts(detail.identity.id, [running.jobId], client);
    expect(getRollout).toHaveBeenCalledTimes(1);
    const merged = mergePolledRollouts(detail, [
      { ...polled[0]!, completed: running.completed + 1 },
    ]);
    expect(merged.rollouts[0]!.completed).toBe(running.completed + 1);
    expect(detail.rollouts[0]!.completed).toBe(running.completed);
  });

  it('skips rollout reads when the authoritative platform capability is off', async () => {
    const base = createMockAdminAgentsClient();
    const listRollouts = vi.spyOn(base, 'listRollouts');

    const detail = await fetchAdminAgentDetail('agent-inbox', base, false);

    expect(listRollouts).not.toHaveBeenCalled();
    expect(detail.rollouts).toEqual([]);
    expect(detail.versions.length).toBeGreaterThan(0);
  });

  it('follows opaque cursors up to the page ceiling and stops on repeated cursors', async () => {
    const client = createMockAdminAgentsClient();
    const version = (await client.listVersions({ agentId: 'agent-inbox' })).items[0]!;
    const listVersions = vi
      .spyOn(client, 'listVersions')
      .mockResolvedValueOnce({
        // Older page-1 row first in opaque cursor order — aggregate must re-sort by createdAt.
        items: [
          { ...version, createdAt: new Date('2026-07-16T06:00:00.000Z'), id: 'version-inbox-1' },
        ],
        nextCursor: 'next-page',
      })
      .mockResolvedValueOnce({
        items: [
          {
            ...version,
            createdAt: new Date('2026-07-17T06:00:00.000Z'),
            id: 'version-inbox-2',
            version: '1.0.1',
          },
        ],
        nextCursor: null,
      });

    const detail = await fetchAdminAgentDetail('agent-inbox', client);

    // Canonical aggregate order: newest createdAt first (not opaque page/id order).
    expect(detail.versions.map(({ id }) => id)).toEqual(['version-inbox-2', 'version-inbox-1']);
    expect(listVersions).toHaveBeenNthCalledWith(1, {
      agentId: 'agent-inbox',
      cursor: undefined,
      limit: 100,
    });
    expect(listVersions).toHaveBeenNthCalledWith(2, {
      agentId: 'agent-inbox',
      cursor: 'next-page',
      limit: 100,
    });

    // Cycle guard: a stuck cursor must not spin past the hard page ceiling.
    listVersions.mockReset();
    for (let i = 0; i < ADMIN_AGENT_COLLECTION_PAGE_LIMIT + 5; i += 1) {
      listVersions.mockResolvedValueOnce({
        items: [{ ...version, id: `version-cycle-${i}` }],
        nextCursor: 'same-cursor',
      });
    }
    const cycled = await fetchAdminAgentDetail('agent-inbox', client);
    expect(listVersions.mock.calls.length).toBeLessThanOrEqual(ADMIN_AGENT_COLLECTION_PAGE_LIMIT);
    expect(cycled.versions.length).toBeLessThanOrEqual(ADMIN_AGENT_COLLECTION_PAGE_LIMIT);
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
