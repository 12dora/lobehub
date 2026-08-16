// @vitest-environment happy-dom
import { PLATFORM_AGENT_GLOBAL_TARGET_ID } from '@lobechat/types';
import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isAgentDetailFresh } from './AgentDetailView';
import type { AdminAgentDetailOutput } from './types';
import { useAgentActions } from './useAgentActions';
import { useAssignmentEditor } from './useAssignmentEditor';
import { useRefreshLock } from './useRefreshLock';

const mocks = vi.hoisted(() => ({
  openDangerConfirm: vi.fn(),
  openReasonModal: vi.fn(),
  service: {
    archive: vi.fn(),
    removeAssignment: vi.fn(),
    rollback: vi.fn(),
    setDefaultInbox: vi.fn(),
    upsertAssignment: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: mocks.openReasonModal,
}));
vi.mock('@/enterprise/client/features/admin/primitives/DangerConfirm', () => ({
  openDangerConfirm: mocks.openDangerConfirm,
}));
vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', () => {
  const isAdminReauthRequiredError = (error: unknown) =>
    String((error as { message?: string })?.message ?? '').includes('ADMIN_REAUTH_REQUIRED');
  return {
    AdminReauthBlockedError: class AdminReauthBlockedError extends Error {},
    AdminReauthCancelledError: class AdminReauthCancelledError extends Error {},
    isAdminReauthRequiredError,
    // Mirrors production: one interactive reauth, then exactly one replay of the same call.
    withAdminReauthRetry: async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        if (!isAdminReauthRequiredError(error)) throw error;
        return await fn();
      }
    },
  };
});
vi.mock('@/enterprise/client/services/adminAgents', () => ({ adminAgentsService: mocks.service }));
vi.mock('./useAdminAgents', () => ({
  fetchPublishedAdminAgentReplacements: vi.fn().mockResolvedValue([]),
  findDefaultAdminAgent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@lobehub/ui', () => ({ Flexbox: () => null, Text: () => null }));
vi.mock('@lobehub/ui/base-ui', () => ({
  Select: () => null,
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

/** A COMPLETE authoritative aggregate — the ONLY shape the refresh gate will accept as fresh. */
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

const otherAgent = (revision: number, token: string): AdminAgentDetailOutput =>
  ({
    ...complete(revision, token),
    identity: { ...complete(revision, token).identity, id: 'other' },
  }) as AdminAgentDetailOutput;

const partial = (revision: number, token: string) =>
  ({ draftToken: token.repeat(64), identity: complete(revision, token).identity }) as never;

const casOutput = () => ({
  draftToken: 'e'.repeat(64),
  identity: complete(8, 'e').identity,
  version: { id: 'ver-new' },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const reauthError = () => new Error('ADMIN_REAUTH_REQUIRED');

// The shared SWR mutate: an updater arg = optimistic local cache apply; a bare call = a refresh,
// resolving to whatever `freshRef` currently holds. `cacheApply` lets a test force the optimistic
// cache apply to REJECT (simulating a post-commit local cache failure) while the bare refresh works.
const freshRef: { current: AdminAgentDetailOutput | undefined } = { current: undefined };
const cacheApply: { current: 'ok' | 'throw' } = { current: 'ok' };
const mutate = vi.fn((updater?: unknown) => {
  if (updater) {
    return cacheApply.current === 'throw'
      ? Promise.reject(new Error('cache-apply-failed'))
      : Promise.resolve(undefined);
  }
  return Promise.resolve(freshRef.current);
});

const lastConfig = () => mocks.openReasonModal.mock.calls.at(-1)![0];
/** Archive keeps a confirm-only modal (replacement picker); everything else confirms or fires. */
const submitReasonModal = () => lastConfig().onSubmit(lastConfig().buildPayload('archive'));
const confirmDanger = () => mocks.openDangerConfirm.mock.calls.at(-1)![0].onConfirm();
/** Payload the service actually received for `method`, or the last one. */
const lastCall = (method: keyof typeof mocks.service) =>
  mocks.service[method].mock.calls.at(-1)![0] as Record<string, unknown>;

const renderHarness = (snapshot: AdminAgentDetailOutput) =>
  renderHook(
    ({ snap }: { snap: AdminAgentDetailOutput }) => {
      const snapshotRef = useRef(snap);
      snapshotRef.current = snap;
      const lock = useRefreshLock<AdminAgentDetailOutput>(mutate, {
        getSnapshot: () => snapshotRef.current,
        isFresh: isAgentDetailFresh,
      });
      const actions = useAgentActions({
        authMethod: null,
        lock,
        mutate,
        snapshot: snap,
      });
      const assignment = useAssignmentEditor(snap, null, lock);
      return { actions, assignment, lock };
    },
    { initialProps: { snap: snapshot } },
  );

type Harness = ReturnType<typeof renderHarness>;

beforeEach(() => {
  mocks.openReasonModal.mockReset();
  mocks.openDangerConfirm.mockReset();
  mutate.mockClear();
  freshRef.current = undefined;
  for (const fn of Object.values(mocks.service)) fn.mockReset();
  mocks.service.setDefaultInbox.mockResolvedValue({ nextDefault: casOutput() });
  mocks.service.archive.mockResolvedValue(casOutput());
  mocks.service.rollback.mockResolvedValue({ agentId: 'agent-1', revision: 8 });
  mocks.service.upsertAssignment.mockResolvedValue({ id: 'as-1' });
  mocks.service.removeAssignment.mockResolvedValue({ removed: true });
  cacheApply.current = 'ok';
});

// ---- The write matrix: how to trigger each real write and how its committed output resolves. ----
interface WriteCase {
  /** true → committed output carries advanced CAS locally (resolveWrite, no refresh). */
  cas: boolean;
  /** Performs the write itself; resolves once the whole write settles. Never rejects. */
  commit: (h: Harness) => Promise<void>;
  method: keyof typeof mocks.service;
  name: string;
  /** The user gesture that opens the confirmation (if any). */
  open: (h: Harness) => Promise<void> | void;
}

/** Failures are surfaced by the action itself; the lock assertions are what these tests own. */
const swallow = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch {
    // asserted through the lock / toast surfaces instead
  }
};

const AGENT_WRITES: WriteCase[] = [
  {
    cas: false,
    commit: () => swallow(confirmDanger),
    method: 'rollback',
    name: 'rollback',
    open: (h) => h.result.current.actions.rollback('ver-2'),
  },
  {
    cas: true,
    commit: () => swallow(confirmDanger),
    method: 'setDefaultInbox',
    name: 'setDefaultInbox',
    open: (h) => h.result.current.actions.setDefaultInbox(),
  },
  {
    cas: true,
    commit: () => swallow(submitReasonModal),
    method: 'archive',
    name: 'archive',
    open: (h) => h.result.current.actions.archive(),
  },
];

const editableAssignment = {
  agentId: 'agent-1',
  enabled: true,
  id: 'as-1',
  mode: 'optional',
  pinnedVersionId: null,
  targetId: PLATFORM_AGENT_GLOBAL_TARGET_ID,
  targetType: 'global',
  versionPolicy: 'latest_published',
} as never;

const ASSIGNMENT_WRITES: WriteCase[] = [
  {
    cas: false,
    commit: (h) => swallow(() => h.result.current.assignment.submit()),
    method: 'upsertAssignment',
    name: 'assignment create',
    open: () => undefined,
  },
  // 'assignment update' is exercised as a dedicated REAL test below (edit in one act, rerender,
  // submit in a separate act) so its edited state actually commits — a single-act edit+submit would
  // silently fall back to the create shape.
  {
    cas: false,
    commit: () => swallow(confirmDanger),
    method: 'removeAssignment',
    name: 'assignment remove',
    open: (h) => h.result.current.assignment.remove(editableAssignment),
  },
];

const ALL_WRITES = [...AGENT_WRITES, ...ASSIGNMENT_WRITES];
const REFRESH_WRITES = ALL_WRITES.filter((w) => !w.cas);
const CAS_WRITES = ALL_WRITES.filter((w) => w.cas);

/** Open the confirmation (if any) for a write. */
const fire = async (h: Harness, w: WriteCase) => {
  await act(async () => {
    await w.open(h);
  });
};

/** Open + commit one whole write. */
const write = async (h: Harness, w: WriteCase) => {
  await fire(h, w);
  await act(async () => {
    await w.commit(h);
  });
};

const promptCount = () =>
  mocks.openReasonModal.mock.calls.length + mocks.openDangerConfirm.mock.calls.length;

/**
 * A fresh user attempt: the gesture, then the commit only when the gesture actually produced a
 * NEW confirmation. A gesture the write guard rejected never reaches its service.
 */
const attempt = async (h: Harness, w: WriteCase) => {
  const before = promptCount();
  await fire(h, w);
  if (before > 0 && promptCount() === before) return;
  await act(async () => {
    await w.commit(h);
  });
};

describe('write-lock chain: concurrency (real hooks + real lock)', () => {
  it.each(ALL_WRITES)(
    '$name: a pending service blocks a second write from reaching any service',
    async (w) => {
      const gate = deferred<unknown>();
      mocks.service[w.method].mockReturnValueOnce(gate.promise);
      const h = renderHarness(complete(7, 'b'));
      await fire(h, w);

      // Start the write; it locks synchronously in beginWrite, then parks on the pending service.
      let pending!: Promise<void>;
      await act(async () => {
        pending = w.commit(h);
        await Promise.resolve();
      });
      expect(h.result.current.lock.isLocked()).toBe(true);
      expect(mocks.service[w.method]).toHaveBeenCalledTimes(1);

      // A second attempt of the SAME write is rejected by the action guard — no service call.
      await attempt(h, w);
      expect(mocks.service[w.method]).toHaveBeenCalledTimes(1);

      // Release the service so the write settles (unlock path is asserted elsewhere).
      freshRef.current = complete(8, 'e');
      gate.resolve(w.cas ? casOutput() : { ok: true });
      await act(async () => {
        await pending;
      });
    },
  );

  it.each(ALL_WRITES)(
    '$name: a failed service (non-reauth) aborts the write and unlocks',
    async (w) => {
      mocks.service[w.method].mockRejectedValueOnce(new Error('boom'));
      const h = renderHarness(complete(7, 'b'));
      await write(h, w);
      expect(mocks.service[w.method]).toHaveBeenCalledTimes(1);
      expect(h.result.current.lock.isLocked()).toBe(false);
      expect(h.result.current.lock.refreshFailed).toBe(false);
    },
  );
});

describe('write-lock chain: refresh writes stay locked until a fresh CAS-advanced aggregate', () => {
  it.each(REFRESH_WRITES)(
    '$name: committed + refresh failure stays locked, then a fresh retry unlocks and the next write uses the new CAS',
    async (w) => {
      const h = renderHarness(complete(4, 'b'));
      // Commit; the post-commit refresh returns nothing → stays locked.
      freshRef.current = undefined;
      await write(h, w);
      expect(mocks.service[w.method]).toHaveBeenCalledTimes(1);
      expect(h.result.current.lock.isLocked()).toBe(true);
      expect(h.result.current.lock.refreshFailed).toBe(true);

      // A second write while locked reaches no service.
      const calls = mocks.service[w.method].mock.calls.length;
      await attempt(h, w);
      expect(mocks.service[w.method].mock.calls.length).toBe(calls);

      // A fresh, strictly-advanced aggregate on retry unlocks.
      const refreshed = complete(5, 'c');
      freshRef.current = refreshed;
      await act(async () => {
        await h.result.current.lock.retryRefresh();
      });
      expect(h.result.current.lock.isLocked()).toBe(false);

      // The re-rendered surface authors the next write from the NEW CAS.
      h.rerender({ snap: refreshed });
      await write(h, w);
      const built = lastCall(w.method) as {
        expectedDraftToken: string;
        expectedRevision: number;
      };
      expect(built.expectedRevision).toBe(refreshed.identity.revision);
      expect(built.expectedDraftToken).toBe(refreshed.draftToken);
    },
  );

  it.each<[string, AdminAgentDetailOutput | undefined]>([
    ['a partial detail (missing aggregate arrays)', partial(5, 'c')],
    ['another Agent', otherAgent(5, 'c')],
    ['a revision rollback', complete(3, 'c')],
    ['a token-only change', complete(4, 'c')],
    ['undefined (pending/failed refresh)', undefined],
  ])('rollback + adversarial refresh (%s) keeps the lock engaged', async (_label, adversarial) => {
    const h = renderHarness(complete(4, 'b'));
    freshRef.current = adversarial;
    await write(h, AGENT_WRITES[0]); // rollback
    expect(h.result.current.lock.isLocked()).toBe(true);
    expect(h.result.current.lock.refreshFailed).toBe(true);
  });
});

describe('write-lock chain: CAS-carrying writes unlock immediately from the authoritative output', () => {
  it.each(CAS_WRITES)(
    '$name: applies the advanced CAS locally and ends the cycle (no refresh)',
    async (w) => {
      const h = renderHarness(complete(7, 'b'));
      await write(h, w);
      expect(mocks.service[w.method]).toHaveBeenCalledTimes(1);
      expect(h.result.current.lock.isLocked()).toBe(false);
      expect(h.result.current.lock.refreshFailed).toBe(false);
      // The local CAS was advanced via an optimistic updater — not a bare refresh.
      expect(mutate).toHaveBeenCalledWith(expect.any(Function), { revalidate: false });
    },
  );
});

describe('write-lock chain: shared-reauth is one logical write', () => {
  it('releases the uncommitted write when the reauth challenge never succeeds', async () => {
    // Both the challenge and its single retry fail → nothing committed, the lock must release.
    mocks.service.rollback.mockRejectedValue(reauthError());
    const h = renderHarness(complete(7, 'b'));
    await write(h, AGENT_WRITES[0]); // rollback

    expect(mocks.service.rollback).toHaveBeenCalledTimes(2);
    expect(h.result.current.lock.isLocked()).toBe(false);
  });

  it('the reauth retry commits and unlocks without re-entering beginWrite', async () => {
    mocks.service.rollback
      .mockRejectedValueOnce(reauthError()) // first attempt: challenge
      .mockResolvedValueOnce({ agentId: 'agent-1', revision: 8, versionId: 'v1' }); // retry commits
    freshRef.current = complete(8, 'e');
    const h = renderHarness(complete(7, 'b'));

    // One logical write: beginWrite runs once, the reauth retry replays only the service call.
    await write(h, AGENT_WRITES[0]);
    expect(mocks.service.rollback).toHaveBeenCalledTimes(2);
    expect(mocks.service.rollback.mock.calls[0][0]).toEqual(
      mocks.service.rollback.mock.calls[1][0],
    );
    expect(h.result.current.lock.isLocked()).toBe(false);
  });
});

describe('write-lock chain: a committed write survives a local cache-apply failure', () => {
  it.each(CAS_WRITES)(
    '$name: service commits then the local cache apply throws → stays locked (refresh-required), never aborts',
    async (w) => {
      const h = renderHarness(complete(4, 'b'));
      // The service commits, but the optimistic local cache apply rejects, and the authoritative
      // refresh has nothing fresh yet → the committed write must stay LOCKED, not abort/unlock.
      cacheApply.current = 'throw';
      freshRef.current = undefined;
      await write(h, w);
      expect(mocks.service[w.method]).toHaveBeenCalledTimes(1);
      expect(h.result.current.lock.isLocked()).toBe(true);
      expect(h.result.current.lock.refreshFailed).toBe(true);

      // A second write while locked reaches no service.
      const calls = mocks.service[w.method].mock.calls.length;
      await attempt(h, w);
      expect(mocks.service[w.method].mock.calls.length).toBe(calls);

      // The authoritative aggregate refresh (fresh, strictly advanced) unlocks.
      cacheApply.current = 'ok';
      const refreshed = complete(5, 'c');
      freshRef.current = refreshed;
      await act(async () => {
        await h.result.current.lock.retryRefresh();
      });
      expect(h.result.current.lock.isLocked()).toBe(false);

      // The next write authors from the NEW CAS (setDefaultInbox nests it under `nextDefault`).
      h.rerender({ snap: refreshed });
      await write(h, w);
      const raw = lastCall(w.method);
      const built = (raw.nextDefault ?? raw) as {
        expectedDraftToken: string;
        expectedRevision: number;
      };
      expect(built.expectedRevision).toBe(refreshed.identity.revision);
      expect(built.expectedDraftToken).toBe(refreshed.draftToken);
    },
  );
});

describe('write-lock chain: assignment UPDATE is a real edit→commit chain', () => {
  const upsertCalls = () => mocks.service.upsertAssignment.mock.calls.map(([arg]) => arg);

  it('sends the existing assignmentId + edited normalized fields, blocks a stale second update, and reuses the new CAS', async () => {
    const h = renderHarness(complete(4, 'b'));

    // Edit an existing assignment in one act; let the hook rerender so editingId commits...
    act(() => {
      h.result.current.assignment.edit(editableAssignment);
    });
    expect(h.result.current.assignment.editingId).toBe('as-1');
    // ...then change a field and submit in a SEPARATE act (the real user sequence).
    act(() => {
      h.result.current.assignment.setEnabled(false);
    });

    // Commit; refresh fails → stays locked.
    freshRef.current = undefined;
    await act(async () => {
      await h.result.current.assignment.submit();
    });
    // The UPDATE payload carries the EXISTING assignmentId and the edited normalized fields.
    const built = upsertCalls()[0] as Record<string, unknown>;
    expect(built.assignmentId).toBe('as-1');
    expect(built.enabled).toBe(false);
    expect(built.targetType).toBe('global');
    expect(built.targetId).toBe(PLATFORM_AGENT_GLOBAL_TARGET_ID);
    expect(built.expectedRevision).toBe(4);
    expect(mocks.service.upsertAssignment).toHaveBeenCalledTimes(1);
    expect(h.result.current.lock.isLocked()).toBe(true);

    // A second UPDATE while locked reaches no service (re-edit + submit → still blocked).
    act(() => {
      h.result.current.assignment.edit(editableAssignment);
    });
    await act(async () => {
      await h.result.current.assignment.submit();
    });
    expect(mocks.service.upsertAssignment).toHaveBeenCalledTimes(1);

    // Refresh with a fresh advanced aggregate unlocks.
    freshRef.current = complete(5, 'c');
    await act(async () => {
      await h.result.current.lock.retryRefresh();
    });
    expect(h.result.current.lock.isLocked()).toBe(false);

    // Next UPDATE on the refreshed surface still carries the assignmentId + the NEW CAS.
    h.rerender({ snap: complete(5, 'c') });
    act(() => {
      h.result.current.assignment.edit(editableAssignment);
    });
    await act(async () => {
      await h.result.current.assignment.submit();
    });
    const next = upsertCalls().at(-1) as Record<string, unknown>;
    expect(next.assignmentId).toBe('as-1');
    expect(next.expectedRevision).toBe(5);
    expect(next.expectedDraftToken).toBe('c'.repeat(64));

    // NEGATIVE: the create shape (missing assignmentId) is NEVER used in the update case.
    expect(
      upsertCalls().every((arg) => Boolean((arg as { assignmentId?: string }).assignmentId)),
    ).toBe(true);
  });
});
