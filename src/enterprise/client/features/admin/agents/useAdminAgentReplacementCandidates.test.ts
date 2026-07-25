// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockAdminAgentsClient } from './__tests__/mockAdminAgents';
import {
  useAdminAgentReplacementCandidates,
  useDebouncedValue,
} from './useAdminAgentReplacementCandidates';

const mocks = vi.hoisted(() => ({
  fetchers: [] as (() => Promise<unknown>)[],
  keys: [] as unknown[],
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown, fetcher: () => Promise<unknown>) => {
    mocks.keys.push(key);
    mocks.fetchers.push(fetcher);
    return {
      data: undefined,
      error: undefined,
      isLoading: Boolean(key),
      isValidating: false,
      mutate: vi.fn(),
    };
  },
}));

vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: {},
}));

describe('useAdminAgentReplacementCandidates', () => {
  beforeEach(() => {
    mocks.fetchers.length = 0;
    mocks.keys.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces the search query and keys SWR with excludeAgentId + debounced query', async () => {
    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useDebouncedValue(query, 250),
      { initialProps: { query: 'a' } },
    );
    expect(result.current).toBe('a');
    rerender({ query: 'ab' });
    rerender({ query: 'abc' });
    expect(result.current).toBe('a');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(result.current).toBe('abc');
  });

  it('passes a null SWR key when disabled and uses the injected client when enabled', async () => {
    const client = createMockAdminAgentsClient();
    const list = vi.spyOn(client, 'list');

    renderHook(() => useAdminAgentReplacementCandidates('agent-inbox', '', false, client));
    expect(mocks.keys.at(-1)).toBeNull();

    renderHook(() => useAdminAgentReplacementCandidates('agent-inbox', 'research', true, client));
    // Debounced query starts as 'research' on first mount.
    expect(mocks.keys.at(-1)).toEqual([
      'enterprise.admin.agents.archive.replacements',
      'agent-inbox',
      'research',
    ]);
    const items = await mocks.fetchers.at(-1)!();
    expect(list).toHaveBeenCalledWith({
      limit: 50,
      query: 'research',
      status: 'published',
    });
    expect(Array.isArray(items)).toBe(true);
  });
});
