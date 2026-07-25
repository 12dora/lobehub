// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockAdminAgentsClient } from './__tests__/mockAdminAgents';
import type { AdminAgentDetailOutput } from './types';
import { fetchAdminAgentDetail, useFetchAdminAgent } from './useAdminAgents';

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  useActiveWorkspaceId: () => undefined,
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
);

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 8; index++) await Promise.resolve();
  });
};

const createPollingClient = async () => {
  const client = createMockAdminAgentsClient();
  const detail = await fetchAdminAgentDetail('agent-inbox', client);
  const first = detail.rollouts[0]!;
  const second = { ...first, jobId: 'rollout-inbox-2' };
  const current = new Map<string, AdminAgentDetailOutput['rollouts'][number]>([
    [first.jobId, first],
    [second.jobId, second],
  ]);
  // Honour status the way the server does after R5 — completed/failed leave the active set.
  vi.spyOn(client, 'listRollouts').mockImplementation(async (input) => {
    const items = [...current.values()].filter((row) =>
      input.status && input.status.length > 0 ? input.status.includes(row.status) : true,
    );
    return { items, nextCursor: null };
  });
  vi.spyOn(client, 'getRollout').mockImplementation(async ({ jobId }) => {
    const row = current.get(jobId);
    if (!row) throw new Error(`missing rollout ${jobId}`);
    return structuredClone(row);
  });
  return { client, current, first, second };
};

describe('active Agent rollout polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls via listRollouts without refetching detail collections, then stops and cleans up', async () => {
    const { client, current, first, second } = await createPollingClient();
    const get = vi.spyOn(client, 'get');
    const assignments = vi.spyOn(client, 'listAssignments');
    const rollouts = vi.spyOn(client, 'listRollouts');
    const versions = vi.spyOn(client, 'listVersions');
    const getRollout = vi.spyOn(client, 'getRollout');
    const { result, unmount } = renderHook(
      () => useFetchAdminAgent('agent-inbox', true, client, true),
      { wrapper },
    );
    await flush();

    expect(result.current.data?.rollouts).toHaveLength(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(assignments).toHaveBeenCalledTimes(1);
    // Initial detail drain + first poll interval list.
    expect(rollouts.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(versions).toHaveBeenCalledTimes(1);
    // Prefer list-status over N×getRollout.
    expect(getRollout).not.toHaveBeenCalled();

    const listCallsAfterDetail = rollouts.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(get).toHaveBeenCalledTimes(1);
    expect(assignments).toHaveBeenCalledTimes(1);
    expect(versions).toHaveBeenCalledTimes(1);
    expect(rollouts.mock.calls.length).toBeGreaterThan(listCallsAfterDetail);
    expect(getRollout).not.toHaveBeenCalled();

    current.set(first.jobId, { ...first, status: 'completed' });
    current.set(second.jobId, { ...second, status: 'failed' });
    const getRolloutCallsBeforeCompletion = getRollout.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await flush();
    // Status-filtered list no longer returns terminal jobs → missing → getRollout fallback.
    expect(getRollout.mock.calls.length).toBeGreaterThan(getRolloutCallsBeforeCompletion);
    expect(getRollout).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-inbox', jobId: first.jobId }),
    );
    expect(getRollout).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-inbox', jobId: second.jobId }),
    );
    expect(result.current.data?.rollouts.map(({ status }) => status)).toEqual([
      'completed',
      'failed',
    ]);
    const stoppedAt = rollouts.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    // No active jobs → poll key null → no further list polls.
    expect(rollouts).toHaveBeenCalledTimes(stoppedAt);

    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(rollouts).toHaveBeenCalledTimes(stoppedAt);
  });

  it('keeps loaded detail on poll error and retries only the lightweight list-status request', async () => {
    const { client, current, first } = await createPollingClient();
    vi.mocked(client.listRollouts)
      .mockResolvedValueOnce({ items: [first], nextCursor: null }) // detail drain (no status)
      .mockRejectedValueOnce(new Error('poll unavailable'))
      // Filtered active poll: completed job is gone from the list.
      .mockResolvedValue({ items: [], nextCursor: null });
    const get = vi.spyOn(client, 'get');
    const assignments = vi.spyOn(client, 'listAssignments');
    const versions = vi.spyOn(client, 'listVersions');
    const getRollout = vi.spyOn(client, 'getRollout');
    const { result } = renderHook(() => useFetchAdminAgent('agent-inbox', true, client, true), {
      wrapper,
    });
    await flush();

    expect(result.current.data?.identity.id).toBe('agent-inbox');
    expect(result.current.rolloutPollError).toBeInstanceOf(Error);
    current.set(first.jobId, { ...first, status: 'completed' });
    await act(async () => {
      await result.current.retryRolloutPoll();
    });
    await flush();
    expect(result.current.data?.rollouts[0]!.status).toBe('completed');
    // Completion observed via getRollout fallback, not by smuggling terminal rows into the list.
    expect(getRollout).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-inbox', jobId: first.jobId }),
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(assignments).toHaveBeenCalledTimes(1);
    expect(versions).toHaveBeenCalledTimes(1);
  });
});
