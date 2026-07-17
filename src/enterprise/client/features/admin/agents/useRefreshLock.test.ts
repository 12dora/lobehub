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

const baseline = detail();

const advanced = (revision: number, token: string) =>
  detail({
    draftToken: token.repeat(64),
    identity: { currentVersionId: 'v1', id: 'agent-1', revision },
  });

const mount = (
  mutate: () => Promise<AdminAgentDetailOutput | undefined>,
  getSnapshot: () => AdminAgentDetailOutput | undefined = () => baseline,
) =>
  renderHook(() =>
    useRefreshLock<AdminAgentDetailOutput>(mutate, { getSnapshot, isFresh: isAgentDetailFresh }),
  );

const run = async (result: { current: ReturnType<typeof useRefreshLock> }) => {
  await act(async () => {
    await result.current.syncAfterCommit();
  });
};

describe('useRefreshLock (frozen baseline + CAS-advanced freshness)', () => {
  it('unlocks only after a complete, strictly-advanced detail', async () => {
    const { result } = mount(vi.fn().mockResolvedValue(advanced(2, 'b')));
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
    ['revision rollback', () => Promise.resolve(advanced(0, 'b'))],
    ['token-only change (revision not advanced)', () => Promise.resolve(advanced(1, 'b'))],
    [
      'different Agent',
      () =>
        Promise.resolve(
          detail({
            draftToken: 'b'.repeat(64),
            identity: { currentVersionId: 'v1', id: 'other', revision: 2 },
          }),
        ),
    ],
    ['rejected refresh', () => Promise.reject(new Error('network'))],
  ])('stays LOCKED on %s', async (_label, mutate) => {
    const { result } = mount(mutate);
    await run(result);
    expect(result.current.isLocked()).toBe(true);
    expect(result.current.refreshFailed).toBe(true);
  });

  it('compares retries against the FROZEN pre-commit baseline even if the live snapshot advanced', async () => {
    // Live snapshot advances in the background (revision 2) while locked; the baseline stays at 1.
    const live = { current: baseline };
    const mutate = vi
      .fn<() => Promise<AdminAgentDetailOutput | undefined>>()
      .mockResolvedValueOnce(undefined) // refresh fails → lock, freeze baseline (revision 1)
      .mockResolvedValueOnce(advanced(2, 'b')); // retry returns revision 2 → advanced past frozen 1
    const { result } = mount(mutate, () => live.current);

    await run(result);
    expect(result.current.isLocked()).toBe(true);

    // A background revalidation bumps the live snapshot; it must NOT become the new baseline.
    live.current = advanced(2, 'b');

    await act(async () => {
      await result.current.retryRefresh();
    });
    // 2 > frozen-baseline 1 → unlocks (would be stuck if it re-read the live revision-2 snapshot).
    expect(result.current.isLocked()).toBe(false);
    expect(result.current.refreshFailed).toBe(false);
  });
});

describe('isAgentDetailFresh', () => {
  it('requires same Agent, complete valid fields, revision strictly advanced, token changed', () => {
    expect(isAgentDetailFresh(undefined, baseline)).toBe(false);
    expect(isAgentDetailFresh({ identity: { revision: 2 } } as never, baseline)).toBe(false);
    expect(isAgentDetailFresh(detail(), undefined)).toBe(false); // no baseline
    expect(isAgentDetailFresh(detail(), baseline)).toBe(false); // same CAS
    expect(isAgentDetailFresh(advanced(0, 'b'), baseline)).toBe(false); // rollback
    expect(isAgentDetailFresh(advanced(1, 'b'), baseline)).toBe(false); // token-only, no revision advance
    expect(
      isAgentDetailFresh(
        detail({ identity: { currentVersionId: 'v9', id: 'agent-1', revision: 1 } }),
        baseline,
      ),
    ).toBe(false); // currentVersionId-only is NOT sole proof
    expect(
      isAgentDetailFresh(
        detail({
          draftToken: 'b'.repeat(64),
          identity: { currentVersionId: 'v1', id: 'other', revision: 2 },
        }),
        baseline,
      ),
    ).toBe(false); // different Agent
    expect(isAgentDetailFresh(advanced(2, 'b'), baseline)).toBe(true); // revision advanced + token changed
  });
});
