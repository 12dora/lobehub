// @vitest-environment happy-dom
import { PLATFORM_AGENT_GLOBAL_TARGET_ID } from '@lobechat/types';
import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { isAgentDetailFresh } from './AgentDetailView';
import { deriveAdminAgentPermissions } from './controller';
import type { AdminAgentDetailOutput } from './types';
import { useAgentActions } from './useAgentActions';
import { useAssignmentEditor } from './useAssignmentEditor';
import { useRefreshLock } from './useRefreshLock';

const mocks = vi.hoisted(() => ({
  openReasonModal: vi.fn(),
  service: {
    appendVersion: vi.fn(),
    archive: vi.fn(),
    publish: vi.fn(),
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
vi.mock('@/enterprise/client/services/adminAgents', () => ({ adminAgentsService: mocks.service }));
vi.mock('./useAdminAgents', () => ({ fetchAllAdminAgents: vi.fn().mockResolvedValue([]) }));
vi.mock('@lobehub/ui', () => ({ Flexbox: () => null, Text: () => null }));
vi.mock('@lobehub/ui/base-ui', () => ({
  Select: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}));

const permissions = deriveAdminAgentPermissions([
  PLATFORM_PERMISSIONS.AGENT_PUBLISH,
  PLATFORM_PERMISSIONS.AGENT_UPDATE,
  PLATFORM_PERMISSIONS.AGENT_ASSIGN,
]);

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

const editor = {
  draft: {
    config: {
      avatar: null,
      backgroundColor: null,
      description: null,
      displayName: 'Assistant',
      modelParameters: {},
      openingMessage: null,
      openingQuestions: [],
      systemRole: 'Help the user.',
      tags: [],
    },
    dependencies: {
      connectors: [],
      model: {
        modelKey: 'gpt-4.1',
        providerChecksum: 'a'.repeat(64),
        providerKey: 'openai',
        providerRevision: 1,
      },
      skills: [],
    },
    version: '1.0.0',
  },
  markSaved: vi.fn(),
  setConflict: vi.fn(),
  setSaveState: vi.fn(),
} as never;

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
        editor,
        lock,
        mutate,
        permissions,
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
  mutate.mockClear();
  freshRef.current = undefined;
  for (const fn of Object.values(mocks.service)) fn.mockReset();
  mocks.service.appendVersion.mockResolvedValue(casOutput());
  mocks.service.setDefaultInbox.mockResolvedValue({ nextDefault: casOutput() });
  mocks.service.archive.mockResolvedValue(casOutput());
  mocks.service.publish.mockResolvedValue({ agentId: 'agent-1', revision: 8, versionId: 'v1' });
  mocks.service.rollback.mockResolvedValue({ agentId: 'agent-1', revision: 8 });
  mocks.service.upsertAssignment.mockResolvedValue({ id: 'as-1' });
  mocks.service.removeAssignment.mockResolvedValue({ removed: true });
  cacheApply.current = 'ok';
});

// ---- The write matrix: how to trigger each real write and how its committed output resolves. ----
interface WriteCase {
  /** true → committed output carries advanced CAS locally (resolveWrite, no refresh). */
  cas: boolean;
  method: keyof typeof mocks.service;
  name: string;
  trigger: (h: Harness) => Promise<void> | void;
}

const AGENT_WRITES: WriteCase[] = [
  {
    cas: true,
    method: 'appendVersion',
    name: 'append/save',
    trigger: (h) => h.result.current.actions.save(),
  },
  {
    cas: false,
    method: 'publish',
    name: 'publish',
    trigger: (h) => h.result.current.actions.publish('v1'),
  },
  {
    cas: false,
    method: 'rollback',
    name: 'rollback',
    trigger: (h) => h.result.current.actions.rollback('ver-2'),
  },
  {
    cas: true,
    method: 'setDefaultInbox',
    name: 'setDefaultInbox',
    trigger: (h) => h.result.current.actions.setDefaultInbox(),
  },
  {
    cas: true,
    method: 'archive',
    name: 'archive',
    trigger: (h) => h.result.current.actions.archive(),
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
    method: 'upsertAssignment',
    name: 'assignment create',
    trigger: (h) => h.result.current.assignment.submit(),
  },
  // 'assignment update' is exercised as a dedicated REAL test below (edit in one act, rerender,
  // submit in a separate act) so its edited state actually commits — a single-act edit+submit would
  // silently fall back to the create shape.
  {
    cas: false,
    method: 'removeAssignment',
    name: 'assignment remove',
    trigger: (h) => h.result.current.assignment.remove(editableAssignment),
  },
];

const ALL_WRITES = [...AGENT_WRITES, ...ASSIGNMENT_WRITES];
const REFRESH_WRITES = ALL_WRITES.filter((w) => !w.cas);
const CAS_WRITES = ALL_WRITES.filter((w) => w.cas);

const fire = async (h: Harness, w: WriteCase) => {
  await act(async () => {
    await w.trigger(h);
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
      const config = lastConfig();

      // Start the write; it locks synchronously in beginWrite, then parks on the pending service.
      let pending!: Promise<void>;
      act(() => {
        pending = config.onSubmit(config.buildPayload('reason'));
      });
      expect(h.result.current.lock.isLocked()).toBe(true);
      expect(mocks.service[w.method]).toHaveBeenCalledTimes(1);

      // A second attempt of the SAME write is rejected by the action guard — no new modal, no service.
      const modalCount = mocks.openReasonModal.mock.calls.length;
      await fire(h, w);
      expect(mocks.openReasonModal.mock.calls.length).toBe(modalCount);
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
      await fire(h, w);
      const config = lastConfig();
      await act(async () => {
        await expect(config.onSubmit(config.buildPayload('reason'))).rejects.toThrow('boom');
      });
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
      await fire(h, w);
      const first = lastConfig();
      await act(async () => {
        await first.onSubmit(first.buildPayload('reason'));
      });
      expect(mocks.service[w.method]).toHaveBeenCalledTimes(1);
      expect(h.result.current.lock.isLocked()).toBe(true);
      expect(h.result.current.lock.refreshFailed).toBe(true);

      // A second write while locked reaches no service.
      const calls = mocks.service[w.method].mock.calls.length;
      await fire(h, w);
      expect(mocks.service[w.method].mock.calls.length).toBe(calls);

      // A fresh, strictly-advanced aggregate on retry unlocks.
      freshRef.current = complete(5, 'c');
      await act(async () => {
        await h.result.current.lock.retryRefresh();
      });
      expect(h.result.current.lock.isLocked()).toBe(false);

      // The re-rendered surface authors the next write from the NEW CAS.
      h.rerender({ snap: complete(5, 'c') });
      await fire(h, w);
      const next = lastConfig();
      const built = next.buildPayload('again') as {
        expectedDraftToken: string;
        expectedRevision: number;
      };
      expect(built.expectedRevision).toBe(5);
      expect(built.expectedDraftToken).toBe('c'.repeat(64));
    },
  );

  it.each<[string, AdminAgentDetailOutput | undefined]>([
    ['a partial detail (missing aggregate arrays)', partial(5, 'c')],
    ['another Agent', otherAgent(5, 'c')],
    ['a revision rollback', complete(3, 'c')],
    ['a token-only change', complete(4, 'c')],
    ['undefined (pending/failed refresh)', undefined],
  ])('publish + adversarial refresh (%s) keeps the lock engaged', async (_label, adversarial) => {
    const h = renderHarness(complete(4, 'b'));
    freshRef.current = adversarial;
    await fire(h, AGENT_WRITES[1]); // publish
    const config = lastConfig();
    await act(async () => {
      await config.onSubmit(config.buildPayload('reason'));
    });
    expect(h.result.current.lock.isLocked()).toBe(true);
    expect(h.result.current.lock.refreshFailed).toBe(true);
  });
});

describe('write-lock chain: CAS-carrying writes unlock immediately from the authoritative output', () => {
  it.each(CAS_WRITES)(
    '$name: applies the advanced CAS locally and ends the cycle (no refresh)',
    async (w) => {
      const h = renderHarness(complete(7, 'b'));
      await fire(h, w);
      const config = lastConfig();
      await act(async () => {
        await config.onSubmit(config.buildPayload('reason'));
      });
      expect(mocks.service[w.method]).toHaveBeenCalledTimes(1);
      expect(h.result.current.lock.isLocked()).toBe(false);
      expect(h.result.current.lock.refreshFailed).toBe(false);
      // The local CAS was advanced via an optimistic updater — not a bare refresh.
      expect(mutate).toHaveBeenCalledWith(expect.any(Function), { revalidate: false });
    },
  );
});

describe('write-lock chain: shared-reauth is one logical write', () => {
  it('keeps the frozen baseline across a reauth challenge and releases it only when the retry is cancelled', async () => {
    mocks.service.publish.mockRejectedValueOnce(reauthError());
    const h = renderHarness(complete(7, 'b'));
    await fire(h, AGENT_WRITES[1]); // publish
    const config = lastConfig();

    // The first attempt throws ADMIN_REAUTH_REQUIRED: the modal will run the popup + one retry, so
    // the write stays locked with its frozen baseline (NOT aborted between challenge and retry).
    await act(async () => {
      await expect(config.onSubmit(config.buildPayload('reason'))).rejects.toThrow(
        'ADMIN_REAUTH_REQUIRED',
      );
    });
    expect(h.result.current.lock.isLocked()).toBe(true);

    // The reauth is cancelled → the modal returns to idle → the uncommitted write is released.
    act(() => {
      config.onPhaseChange?.('idle');
    });
    expect(h.result.current.lock.isLocked()).toBe(false);
    expect(mocks.service.publish).toHaveBeenCalledTimes(1);
  });

  it('the reauth retry (same token) commits and unlocks without re-freezing the baseline', async () => {
    mocks.service.publish
      .mockRejectedValueOnce(reauthError()) // first attempt: challenge
      .mockResolvedValueOnce({ agentId: 'agent-1', revision: 8, versionId: 'v1' }); // retry commits
    freshRef.current = complete(8, 'e');
    const h = renderHarness(complete(7, 'b'));
    await fire(h, AGENT_WRITES[1]);
    const config = lastConfig();

    await act(async () => {
      await expect(config.onSubmit(config.buildPayload('reason'))).rejects.toThrow();
    });
    expect(h.result.current.lock.isLocked()).toBe(true);

    // The shared reauth wrapper re-invokes onSubmit with the SAME captured token → same write.
    await act(async () => {
      await config.onSubmit(config.buildPayload('reason'));
    });
    expect(mocks.service.publish).toHaveBeenCalledTimes(2);
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
      await fire(h, w);
      const first = lastConfig();
      await act(async () => {
        await first.onSubmit(first.buildPayload('reason'));
      });
      expect(mocks.service[w.method]).toHaveBeenCalledTimes(1);
      expect(h.result.current.lock.isLocked()).toBe(true);
      expect(h.result.current.lock.refreshFailed).toBe(true);

      // A modal idle/finally after a COMMITTED write must NOT unlock it.
      act(() => {
        first.onPhaseChange?.('idle');
      });
      expect(h.result.current.lock.isLocked()).toBe(true);

      // A second write while locked reaches no service.
      const calls = mocks.service[w.method].mock.calls.length;
      await fire(h, w);
      expect(mocks.service[w.method].mock.calls.length).toBe(calls);

      // The authoritative aggregate refresh (fresh, strictly advanced) unlocks.
      cacheApply.current = 'ok';
      freshRef.current = complete(5, 'c');
      await act(async () => {
        await h.result.current.lock.retryRefresh();
      });
      expect(h.result.current.lock.isLocked()).toBe(false);

      // The next write authors from the NEW CAS (setDefaultInbox nests it under `nextDefault`).
      h.rerender({ snap: complete(5, 'c') });
      await fire(h, w);
      const raw = lastConfig().buildPayload('again') as Record<string, unknown>;
      const built = (raw.nextDefault ?? raw) as {
        expectedDraftToken: string;
        expectedRevision: number;
      };
      expect(built.expectedRevision).toBe(5);
      expect(built.expectedDraftToken).toBe('c'.repeat(64));
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
    act(() => {
      h.result.current.assignment.submit();
    });

    // Commit; refresh fails → stays locked.
    freshRef.current = undefined;
    const first = lastConfig();
    const built = first.buildPayload('reason') as Record<string, unknown>;
    // The UPDATE payload carries the EXISTING assignmentId and the edited normalized fields.
    expect(built.assignmentId).toBe('as-1');
    expect(built.enabled).toBe(false);
    expect(built.targetType).toBe('global');
    expect(built.targetId).toBe(PLATFORM_AGENT_GLOBAL_TARGET_ID);
    expect(built.expectedRevision).toBe(4);

    await act(async () => {
      await first.onSubmit(built);
    });
    expect(mocks.service.upsertAssignment).toHaveBeenCalledTimes(1);
    expect(upsertCalls()[0]).toMatchObject({ assignmentId: 'as-1', enabled: false });
    expect(h.result.current.lock.isLocked()).toBe(true);

    // A second UPDATE while locked reaches no service (re-edit + submit → still blocked).
    act(() => {
      h.result.current.assignment.edit(editableAssignment);
    });
    act(() => {
      h.result.current.assignment.submit();
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
    act(() => {
      h.result.current.assignment.submit();
    });
    const next = lastConfig().buildPayload('again') as Record<string, unknown>;
    expect(next.assignmentId).toBe('as-1');
    expect(next.expectedRevision).toBe(5);
    expect(next.expectedDraftToken).toBe('c'.repeat(64));

    // NEGATIVE: the create shape (missing assignmentId) is NEVER used in the update case.
    expect(
      upsertCalls().every((arg) => Boolean((arg as { assignmentId?: string }).assignmentId)),
    ).toBe(true);
  });
});
