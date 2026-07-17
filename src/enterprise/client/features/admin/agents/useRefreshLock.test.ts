// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { isAgentDetailFresh } from './AgentDetailView';
import type { AdminAgentDetailOutput } from './types';
import { useRefreshLock, type WriteToken } from './useRefreshLock';

/**
 * A COMPLETE authoritative aggregate: it parses against the contract Zod schema (full identity +
 * draftToken + the assignments / versions / rollouts collections). Freshness now REQUIRES this
 * exact shape — a partial object can never unlock.
 */
const complete = (revision: number, token: string): AdminAgentDetailOutput =>
  ({
    assignments: [],
    draftToken: token.repeat(64),
    identity: {
      agentKey: 'agent-1',
      currentVersionId: null,
      draftSequence: 0,
      id: 'agent-1',
      isDefault: false,
      migrationRequired: false,
      revision,
      status: 'draft',
      systemKey: null,
    },
    rollouts: [],
    versions: [],
  }) as AdminAgentDetailOutput;

/** Same complete shape but a different Agent id. */
const otherAgent = (revision: number, token: string): AdminAgentDetailOutput =>
  ({
    ...complete(revision, token),
    identity: { ...complete(revision, token).identity, id: 'other' },
  }) as AdminAgentDetailOutput;

/** A partial detail with a valid id/revision/token but MISSING the aggregate arrays. */
const partial = (revision: number, token: string) =>
  ({ draftToken: token.repeat(64), identity: complete(revision, token).identity }) as never;

const baseline = complete(1, 'a');

const mount = (
  mutate: () => Promise<AdminAgentDetailOutput | undefined>,
  getSnapshot: () => AdminAgentDetailOutput | undefined = () => baseline,
) =>
  renderHook(() =>
    useRefreshLock<AdminAgentDetailOutput>(mutate, { getSnapshot, isFresh: isAgentDetailFresh }),
  );

describe('useRefreshLock lifecycle (pre-write baseline + immediate lock)', () => {
  it('beginWrite locks immediately, rejects a concurrent different write, and accepts the same-token reauth retry', () => {
    const { result } = mount(vi.fn());
    const token: WriteToken = {};
    act(() => {
      expect(result.current.beginWrite(token)).toBe(true);
    });
    // Locked the instant the write begins — before any service call — closing the pending window.
    expect(result.current.isLocked()).toBe(true);
    expect(result.current.locked).toBe(true);
    // A DIFFERENT concurrent write is rejected locally and never reaches a service.
    expect(result.current.beginWrite({})).toBe(false);
    // The SAME token (a shared-reauth retry) is accepted as the same logical write.
    expect(result.current.beginWrite(token)).toBe(true);
  });

  it('abortWrite releases the lock when the service failed without committing', () => {
    const { result } = mount(vi.fn());
    const token = {};
    act(() => {
      result.current.beginWrite(token);
    });
    act(() => {
      result.current.abortWrite(token);
    });
    expect(result.current.isLocked()).toBe(false);
    expect(result.current.refreshFailed).toBe(false);
  });

  it('a foreign token can neither abort nor resolve an active write', () => {
    const { result } = mount(vi.fn());
    const token = {};
    act(() => {
      result.current.beginWrite(token);
    });
    act(() => {
      result.current.abortWrite({}); // wrong token → no-op
      result.current.resolveWrite({}); // wrong token → no-op
    });
    expect(result.current.isLocked()).toBe(true);
  });

  it('resolveWrite ends the cycle when the output already advanced the CAS locally', () => {
    const { result } = mount(vi.fn());
    const token = {};
    act(() => {
      result.current.beginWrite(token);
    });
    act(() => {
      result.current.resolveWrite(token);
    });
    expect(result.current.isLocked()).toBe(false);
  });

  it('commitWrite unlocks on a complete, strictly-advanced aggregate', async () => {
    const { result } = mount(vi.fn().mockResolvedValue(complete(2, 'b')));
    const token = {};
    act(() => {
      result.current.beginWrite(token);
    });
    await act(async () => {
      await result.current.commitWrite(token);
    });
    expect(result.current.isLocked()).toBe(false);
    expect(result.current.refreshFailed).toBe(false);
  });

  it.each<[string, () => Promise<AdminAgentDetailOutput | undefined>]>([
    ['undefined result', () => Promise.resolve(undefined)],
    ['partial detail (missing aggregate arrays)', () => Promise.resolve(partial(2, 'b'))],
    ['unchanged CAS', () => Promise.resolve(complete(1, 'a'))],
    ['revision rollback', () => Promise.resolve(complete(0, 'b'))],
    ['token-only change (revision not advanced)', () => Promise.resolve(complete(1, 'b'))],
    ['different Agent', () => Promise.resolve(otherAgent(2, 'b'))],
    ['rejected refresh', () => Promise.reject(new Error('network'))],
  ])('commitWrite stays LOCKED on %s', async (_label, mutate) => {
    const { result } = mount(mutate);
    const token = {};
    act(() => {
      result.current.beginWrite(token);
    });
    await act(async () => {
      await result.current.commitWrite(token);
    });
    expect(result.current.isLocked()).toBe(true);
    expect(result.current.refreshFailed).toBe(true);
  });

  it('freezes the pre-write baseline: a background snapshot advance never becomes the baseline', async () => {
    const live = { current: baseline };
    const mutate = vi
      .fn<() => Promise<AdminAgentDetailOutput | undefined>>()
      .mockResolvedValueOnce(undefined) // commit refresh fails → lock, baseline frozen at revision 1
      .mockResolvedValueOnce(complete(2, 'b')); // retry: revision 2 > frozen 1 → fresh
    const { result } = mount(mutate, () => live.current);
    const token = {};
    act(() => {
      result.current.beginWrite(token);
    });
    await act(async () => {
      await result.current.commitWrite(token);
    });
    expect(result.current.isLocked()).toBe(true);

    // A background revalidation bumps the LIVE snapshot; it must NOT replace the frozen baseline.
    live.current = complete(2, 'b');
    await act(async () => {
      await result.current.retryRefresh();
    });
    // 2 > frozen-baseline 1 → unlocks (would be stuck if it re-read the live revision-2 snapshot).
    expect(result.current.isLocked()).toBe(false);
    expect(result.current.refreshFailed).toBe(false);
  });
});

describe('isAgentDetailFresh (authoritative aggregate schema)', () => {
  it('unlocks ONLY on a complete aggregate for the same Agent, strictly advanced, token changed', () => {
    expect(isAgentDetailFresh(complete(2, 'b'), baseline)).toBe(true);
  });

  it.each<[string, AdminAgentDetailOutput | undefined]>([
    ['undefined', undefined],
    ['partial (missing aggregate arrays)', partial(2, 'b')],
    ['unchanged CAS', complete(1, 'a')],
    ['revision rollback', complete(0, 'b')],
    ['token-only, revision not advanced', complete(1, 'b')],
    ['different Agent', otherAgent(2, 'b')],
  ])('rejects %s', (_label, result) => {
    expect(isAgentDetailFresh(result, baseline)).toBe(false);
  });

  it('rejects everything when there is no real baseline', () => {
    expect(isAgentDetailFresh(complete(2, 'b'), undefined)).toBe(false);
  });
});
