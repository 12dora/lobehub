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
  vi.spyOn(client, 'listRollouts').mockResolvedValue({ items: [first, second], nextCursor: null });
  vi.spyOn(client, 'getRollout').mockImplementation(async ({ jobId }) => current.get(jobId)!);
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

  it('polls multiple active job ids without refetching detail collections, then stops and cleans up', async () => {
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
    expect(rollouts).toHaveBeenCalledTimes(1);
    expect(versions).toHaveBeenCalledTimes(1);
    expect(getRollout).toHaveBeenCalledWith({ agentId: 'agent-inbox', jobId: first.jobId });
    expect(getRollout).toHaveBeenCalledWith({ agentId: 'agent-inbox', jobId: second.jobId });

    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(get).toHaveBeenCalledTimes(1);
    expect(assignments).toHaveBeenCalledTimes(1);
    expect(rollouts).toHaveBeenCalledTimes(1);
    expect(versions).toHaveBeenCalledTimes(1);

    current.set(first.jobId, { ...first, status: 'completed' });
    current.set(second.jobId, { ...second, status: 'failed' });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await flush();
    expect(result.current.data?.rollouts.map(({ status }) => status)).toEqual([
      'completed',
      'failed',
    ]);
    const stoppedAt = getRollout.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(getRollout).toHaveBeenCalledTimes(stoppedAt);

    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(getRollout).toHaveBeenCalledTimes(stoppedAt);
  });

  it('keeps loaded detail on poll error and retries only the lightweight job request', async () => {
    const { client, first } = await createPollingClient();
    vi.mocked(client.listRollouts).mockResolvedValue({ items: [first], nextCursor: null });
    const get = vi.spyOn(client, 'get');
    const assignments = vi.spyOn(client, 'listAssignments');
    const rollouts = vi.spyOn(client, 'listRollouts');
    const versions = vi.spyOn(client, 'listVersions');
    const getRollout = vi
      .spyOn(client, 'getRollout')
      .mockRejectedValueOnce(new Error('poll unavailable'))
      .mockResolvedValue({ ...first, status: 'completed' });
    const { result } = renderHook(() => useFetchAdminAgent('agent-inbox', true, client, true), {
      wrapper,
    });
    await flush();

    expect(result.current.data?.identity.id).toBe('agent-inbox');
    expect(result.current.rolloutPollError).toBeInstanceOf(Error);
    await act(async () => {
      await result.current.retryRolloutPoll();
    });
    await flush();
    expect(result.current.data?.rollouts[0]!.status).toBe('completed');
    expect(getRollout).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(assignments).toHaveBeenCalledTimes(1);
    expect(rollouts).toHaveBeenCalledTimes(1);
    expect(versions).toHaveBeenCalledTimes(1);
  });
});
