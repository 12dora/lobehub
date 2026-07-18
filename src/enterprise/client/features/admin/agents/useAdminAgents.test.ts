// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockAdminAgentsClient } from './mockAdminAgents';
import {
  clearAdminAgentCache,
  fetchActiveAdminAgentRollouts,
  fetchAdminAgentDetail,
  mergePolledRollouts,
  refreshAdminAgent,
  refreshAdminAgentLists,
  selectActiveRolloutJobIds,
  useFetchAdminAgent,
  useFetchAdminAgents,
} from './useAdminAgents';

const mocks = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  fetchers: [] as (() => Promise<unknown>)[],
  keys: [] as unknown[],
  mutate: vi.fn(),
}));

vi.mock('swr', () => ({ mutate: mocks.mutate }));
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
    mocks.mutate.mockReset().mockResolvedValue(undefined);
  });

  it('keeps disabled reads null and never invokes the injected client', () => {
    const client = createMockAdminAgentsClient();
    const get = vi.spyOn(client, 'get');
    const list = vi.spyOn(client, 'list');
    renderHook(() => useFetchAdminAgents({}, false, client));
    renderHook(() => useFetchAdminAgent('agent-1', false, client));
    expect(mocks.keys).toEqual([null, null, null]);
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('runs reads and the detail aggregate through the injected client boundary', async () => {
    const client = createMockAdminAgentsClient();
    const get = vi.spyOn(client, 'get');
    const list = vi.spyOn(client, 'list');
    const assignments = vi.spyOn(client, 'listAssignments');
    const rollouts = vi.spyOn(client, 'listRollouts');
    const versions = vi.spyOn(client, 'listVersions');
    renderHook(() => useFetchAdminAgents({ status: 'draft' }, true, client));
    renderHook(() => useFetchAdminAgent('agent-inbox', true, client));
    await mocks.fetchers[0]!();
    const detail = await mocks.fetchers[1]!();
    expect(list).toHaveBeenCalledWith({ status: 'draft' });
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
    expect(mocks.configs[1]!.refreshInterval).toBeUndefined();
    expect(mocks.keys[2]).toBeNull();
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

  it('follows opaque cursors so detail collections are never silently truncated', async () => {
    const client = createMockAdminAgentsClient();
    const version = (await client.listVersions({ agentId: 'agent-inbox' })).items[0]!;
    const listVersions = vi
      .spyOn(client, 'listVersions')
      .mockResolvedValueOnce({ items: [version], nextCursor: 'next-page' })
      .mockResolvedValueOnce({
        items: [{ ...version, id: 'version-inbox-2', version: '1.0.1' }],
        nextCursor: null,
      });

    const detail = await fetchAdminAgentDetail('agent-inbox', client);

    expect(detail.versions.map(({ id }) => id)).toEqual(['version-inbox-1', 'version-inbox-2']);
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
  });

  it('invalidates list and detail caches after writes', async () => {
    await refreshAdminAgentLists();
    const listPredicate = mocks.mutate.mock.calls[0]![0] as (key: unknown) => boolean;
    expect(listPredicate(['enterprise.admin.agents.list', {}])).toBe(true);
    expect(listPredicate(['enterprise.admin.agents.get', 'agent-1'])).toBe(false);

    mocks.mutate.mockClear();
    await refreshAdminAgent('agent-1');
    const detailPredicate = mocks.mutate.mock.calls[0]![0] as (key: unknown) => boolean;
    expect(detailPredicate(['enterprise.admin.agents.get', 'agent-1', true])).toBe(true);
    expect(detailPredicate(['enterprise.admin.agents.get', 'agent-2', true])).toBe(false);
    const refreshPredicate = mocks.mutate.mock.calls[1]![0] as (key: unknown) => boolean;
    expect(refreshPredicate(['enterprise.admin.agents.list', {}])).toBe(true);
  });

  it('clears only Agent list/detail cache families without revalidation', async () => {
    await clearAdminAgentCache();
    const [predicate, value, options] = mocks.mutate.mock.calls[0]!;
    expect((predicate as (key: unknown) => boolean)(['enterprise.admin.agents.list', {}])).toBe(
      true,
    );
    expect((predicate as (key: unknown) => boolean)(['enterprise.admin.connectors.list', {}])).toBe(
      false,
    );
    expect(value).toBeUndefined();
    expect(options).toEqual({ revalidate: false });
  });
});
