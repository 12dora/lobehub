// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { isAgentDetailFresh } from './AgentDetailView';
import type { AdminAgentDetailOutput } from './types';
import { useRefreshLock } from './useRefreshLock';

const detail = (over: Record<string, unknown> = {}): AdminAgentDetailOutput =>
  ({
    assignments: [],
    draftToken: 'a'.repeat(64),
    identity: { currentVersionId: 'v1', id: 'agent-1', revision: 1 },
    rollouts: [],
    versions: [],
    ...over,
  }) as unknown as AdminAgentDetailOutput;

const previous = detail({
  draftToken: 'a'.repeat(64),
  identity: { currentVersionId: 'v1', id: 'agent-1', revision: 1 },
});

const mount = (mutate: () => Promise<AdminAgentDetailOutput | undefined>) =>
  renderHook(() =>
    useRefreshLock<AdminAgentDetailOutput>(mutate, {
      getSnapshot: () => previous,
      isFresh: isAgentDetailFresh,
    }),
  );

const run = async (result: { current: ReturnType<typeof useRefreshLock> }) => {
  await act(async () => {
    await result.current.syncAfterCommit();
  });
};

describe('useRefreshLock (CAS-advanced freshness required)', () => {
  it('unlocks only after a complete, CAS-advanced detail', async () => {
    const mutate = vi.fn().mockResolvedValue(
      detail({
        draftToken: 'b'.repeat(64),
        identity: { currentVersionId: 'v2', id: 'agent-1', revision: 2 },
      }),
    );
    const { result } = mount(mutate);
    await run(result);
    expect(result.current.isLocked()).toBe(false);
    expect(result.current.refreshFailed).toBe(false);
  });

  it.each<[string, () => Promise<AdminAgentDetailOutput | undefined>]>([
    ['undefined result', () => Promise.resolve(undefined)],
    [
      'incomplete detail (no draftToken)',
      () => Promise.resolve({ identity: { revision: 2 } } as never),
    ],
    ['unchanged CAS', () => Promise.resolve(detail())],
    ['rejected refresh', () => Promise.reject(new Error('network'))],
  ])('stays LOCKED on %s', async (_label, mutate) => {
    const { result } = mount(mutate);
    await run(result);
    expect(result.current.isLocked()).toBe(true);
    expect(result.current.refreshFailed).toBe(true);
  });

  it('a retry that finally advances CAS unlocks', async () => {
    const mutate = vi
      .fn<() => Promise<AdminAgentDetailOutput | undefined>>()
      .mockResolvedValueOnce(detail()) // same CAS → locked
      .mockResolvedValueOnce(
        detail({
          draftToken: 'c'.repeat(64),
          identity: { currentVersionId: 'v1', id: 'agent-1', revision: 3 },
        }),
      );
    const { result } = mount(mutate);
    await run(result);
    expect(result.current.isLocked()).toBe(true);

    await act(async () => {
      await result.current.retryRefresh();
    });
    expect(result.current.isLocked()).toBe(false);
    expect(result.current.refreshFailed).toBe(false);
  });
});

describe('isAgentDetailFresh', () => {
  it('requires a complete detail advanced past the previous CAS', () => {
    expect(isAgentDetailFresh(undefined, previous)).toBe(false);
    expect(isAgentDetailFresh({ identity: { revision: 2 } } as never, previous)).toBe(false);
    expect(isAgentDetailFresh(detail(), previous)).toBe(false); // same CAS
    expect(
      isAgentDetailFresh(
        detail({
          draftToken: 'b'.repeat(64),
          identity: { currentVersionId: 'v1', id: 'agent-1', revision: 2 },
        }),
        previous,
      ),
    ).toBe(true); // revision advanced
    expect(
      isAgentDetailFresh(
        detail({ identity: { currentVersionId: 'v9', id: 'agent-1', revision: 1 } }),
        previous,
      ),
    ).toBe(true); // current version changed
  });
});
