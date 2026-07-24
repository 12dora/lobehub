// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { deriveAdminAgentPermissions } from './controller';
import type { AdminAgentDetailOutput } from './types';
import { useAgentActions } from './useAgentActions';
import type { RefreshLock } from './useRefreshLock';

const mocks = vi.hoisted(() => ({
  openReasonModal: vi.fn(),
  service: {
    appendVersion: vi.fn(),
    archive: vi.fn(),
    get: vi.fn(),
    publish: vi.fn(),
    rollback: vi.fn(),
    setDefaultInbox: vi.fn(),
  },
  fetchPublishedAdminAgentReplacements: vi.fn(),
  findDefaultAdminAgent: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: mocks.openReasonModal,
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({ adminAgentsService: mocks.service }));
vi.mock('./useAdminAgents', () => ({
  fetchPublishedAdminAgentReplacements: mocks.fetchPublishedAdminAgentReplacements,
  findDefaultAdminAgent: mocks.findDefaultAdminAgent,
}));
vi.mock('@lobehub/ui', () => ({ Flexbox: () => null, Text: () => null }));
vi.mock('@lobehub/ui/base-ui', () => ({
  Input: () => null,
  Select: () => null,
  toast: { error: mocks.toastError, success: vi.fn() },
}));

const snapshot = {
  assignments: [],
  draftToken: 'b'.repeat(64),
  identity: {
    agentKey: 'research',
    currentVersionId: 'v1',
    draftSequence: 1,
    id: 'agent-1',
    isDefault: false,
    migrationRequired: false,
    revision: 7,
    status: 'published',
    systemKey: null,
  },
  rollouts: [],
  versions: [],
} as unknown as AdminAgentDetailOutput;

const permissions = deriveAdminAgentPermissions([
  PLATFORM_PERMISSIONS.AGENT_PUBLISH,
  PLATFORM_PERMISSIONS.AGENT_UPDATE,
  PLATFORM_PERMISSIONS.AGENT_DELETE,
]);

const makeEditor = () =>
  ({
    conflict: false,
    dirty: true,
    discard: vi.fn(),
    draftBaseline: {
      agentId: 'agent-1',
      draftToken: 'b'.repeat(64),
      revision: 7,
    },
    draft: {
      config: {
        avatar: null,
        backgroundColor: null,
        description: null,
        displayName: 'X',
        modelParameters: {},
        openingMessage: null,
        openingQuestions: [],
        systemRole: 'Help the user.',
        tags: [],
      },
      dependencies: {
        connectors: [],
        model: {
          modelKey: 'm',
          providerChecksum: 'a'.repeat(64),
          providerKey: 'p',
          providerRevision: 1,
        },
        skills: [],
      },
      version: '1.0.1',
    },
    markSaved: vi.fn(),
    persistState: null,
    saveState: 'dirty',
    setConflict: vi.fn(),
    setSaveState: vi.fn(),
    updateDraft: vi.fn(),
  }) as any;

/** Controllable fake lock; `refresh` decides whether the post-commit refresh locks (refresh failed). */
const makeLock = (refresh: 'ok' | 'fail'): RefreshLock => {
  let locked = false;
  return {
    abortWrite: vi.fn(() => {
      locked = false;
    }),
    beginWrite: vi.fn(() => {
      locked = true;
      return true;
    }),
    commitWrite: vi.fn(async () => {
      locked = refresh === 'fail';
    }),
    isLocked: () => locked,
    locked: false,
    markCommitted: vi.fn(),
    refreshFailed: false,
    resolveWrite: vi.fn(() => {
      locked = false;
    }),
    retryRefresh: vi.fn(async () => {
      locked = false;
    }),
  };
};

const lastModalConfig = () => mocks.openReasonModal.mock.calls.at(-1)![0];

describe('useAgentActions reauth + commit/refresh + write-lock', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.service)) fn.mockReset();
    mocks.openReasonModal.mockReset();
    mocks.findDefaultAdminAgent.mockReset().mockResolvedValue(undefined);
    mocks.fetchPublishedAdminAgentReplacements.mockReset().mockResolvedValue([]);
    mocks.toastError.mockReset();
  });

  it('routes publish through the shared reauth modal with authMethod and a frozen CAS payload', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    mocks.service.publish.mockResolvedValue({ agentId: 'agent-1', revision: 8, versionId: 'v1' });
    const { result } = renderHook(() =>
      useAgentActions({
        authMethod: 'better-auth',
        editor: makeEditor(),
        lock: makeLock('ok'),
        mutate,
        permissions,
        snapshot,
      }),
    );

    act(() => result.current.publish('v1'));
    const config = lastModalConfig();
    expect(config.authMethod).toBe('better-auth');
    expect(config.buildPayload('do it')).toEqual({
      agentId: 'agent-1',
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 7,
      reason: 'do it',
      versionId: 'v1',
    });

    await act(async () => {
      await config.onSubmit(config.buildPayload('do it'));
    });
    expect(mocks.service.publish).toHaveBeenCalledOnce();
  });

  it('locks a second write after a refresh-failed publish; the re-enabled write uses the NEW CAS', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    const lock = makeLock('fail');
    mocks.service.publish.mockResolvedValue({ agentId: 'agent-1', revision: 8, versionId: 'v1' });
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useAgentActions>[0]) => useAgentActions(props),
      {
        initialProps: {
          authMethod: null,
          editor: makeEditor(),
          lock,
          mutate,
          permissions,
          snapshot,
        },
      },
    );

    act(() => result.current.publish('v1'));
    await act(async () => {
      await lastModalConfig().onSubmit(lastModalConfig().buildPayload('reason'));
    });
    expect(mocks.service.publish).toHaveBeenCalledOnce();
    expect(lock.isLocked()).toBe(true);

    // Second publish while locked must NOT open a modal or call the service again.
    const modalCalls = mocks.openReasonModal.mock.calls.length;
    act(() => result.current.publish('v1'));
    expect(mocks.openReasonModal.mock.calls.length).toBe(modalCalls);
    expect(mocks.service.publish).toHaveBeenCalledOnce();

    // A successful refresh unlocks; the surface re-renders with the advanced CAS.
    await act(async () => {
      await lock.retryRefresh();
    });
    const advanced = {
      ...snapshot,
      draftToken: 'c'.repeat(64),
      identity: { ...snapshot.identity, revision: 8 },
    };
    rerender({
      authMethod: null,
      editor: makeEditor(),
      lock,
      mutate,
      permissions,
      snapshot: advanced,
    });

    act(() => result.current.publish('v1'));
    expect(mocks.openReasonModal.mock.calls.length).toBe(modalCalls + 1);
    // The re-enabled write uses the NEW CAS, never the stale pre-refresh values.
    const built = lastModalConfig().buildPayload('again');
    expect(built.expectedRevision).toBe(8);
    expect(built.expectedDraftToken).toBe('c'.repeat(64));
  });

  it('applies the authoritative appendVersion output locally after a committed save', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    const editor = makeEditor();
    mocks.service.appendVersion.mockResolvedValue({
      draftToken: 'c'.repeat(64),
      identity: { ...snapshot.identity, revision: 8 },
      version: { id: 'v2', version: '1.0.1' },
    });
    const { result } = renderHook(() =>
      useAgentActions({
        authMethod: null,
        editor,
        lock: makeLock('ok'),
        mutate,
        permissions,
        snapshot,
      }),
    );

    act(() => result.current.save());
    // The frozen append-version payload carries the exact config + snapshot + version + CAS.
    expect(lastModalConfig().buildPayload('save it')).toEqual({
      agentId: 'agent-1',
      config: {
        avatar: null,
        backgroundColor: null,
        description: null,
        displayName: 'X',
        modelParameters: {},
        openingMessage: null,
        openingQuestions: [],
        systemRole: 'Help the user.',
        tags: [],
      },
      dependencySnapshot: {
        connectors: [],
        model: {
          modelKey: 'm',
          providerChecksum: 'a'.repeat(64),
          providerKey: 'p',
          providerRevision: 1,
        },
        skills: [],
      },
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 7,
      reason: 'save it',
      version: '1.0.1',
    });
    await act(async () => {
      await lastModalConfig().onSubmit(lastModalConfig().buildPayload('save it'));
    });

    expect(mocks.service.appendVersion).toHaveBeenCalledOnce();
    expect(editor.markSaved).toHaveBeenCalledWith({
      agentId: 'agent-1',
      draftToken: 'c'.repeat(64),
      revision: 8,
    });
    expect(mutate).toHaveBeenCalledWith(expect.any(Function), { revalidate: false });
  });

  it.each([
    ['existing conflict', (editor: ReturnType<typeof makeEditor>) => (editor.conflict = true)],
    [
      'different Agent baseline',
      (editor: ReturnType<typeof makeEditor>) => (editor.draftBaseline.agentId = 'agent-other'),
    ],
    [
      'different revision baseline',
      (editor: ReturnType<typeof makeEditor>) => (editor.draftBaseline.revision = 6),
    ],
    [
      'different draft-token baseline',
      (editor: ReturnType<typeof makeEditor>) => (editor.draftBaseline.draftToken = 'f'.repeat(64)),
    ],
    ['missing baseline', (editor: ReturnType<typeof makeEditor>) => (editor.draftBaseline = null)],
  ])('blocks a direct save call with %s before opening a modal', (_label, mutateEditor) => {
    const editor = makeEditor();
    mutateEditor(editor);
    const { result } = renderHook(() =>
      useAgentActions({
        authMethod: null,
        editor,
        lock: makeLock('ok'),
        mutate: vi.fn(),
        permissions,
        snapshot,
      }),
    );

    act(() => result.current.save());

    expect(editor.setConflict).toHaveBeenCalledWith(true);
    expect(mocks.openReasonModal).not.toHaveBeenCalled();
    expect(mocks.service.appendVersion).not.toHaveBeenCalled();
  });

  it('freezes the modal payload CAS from draftBaseline at the synchronous save boundary', () => {
    const editor = makeEditor();
    const liveSnapshot = {
      ...snapshot,
      identity: { ...snapshot.identity },
    } as AdminAgentDetailOutput;
    const { result } = renderHook(() =>
      useAgentActions({
        authMethod: null,
        editor,
        lock: makeLock('ok'),
        mutate: vi.fn(),
        permissions,
        snapshot: liveSnapshot,
      }),
    );

    act(() => result.current.save());
    // Simulate a mutable external snapshot advancing after the modal opens. The confirmation must
    // retain the baseline primitives captured by save(), not read the live object again.
    liveSnapshot.identity.revision = 99;
    liveSnapshot.draftToken = 'f'.repeat(64);

    const built = lastModalConfig().buildPayload('save it');
    expect(built.expectedRevision).toBe(7);
    expect(built.expectedDraftToken).toBe('b'.repeat(64));
  });

  it('keeps an incomplete recovery draft but blocks it at the explicit save boundary', () => {
    const editor = makeEditor();
    editor.draft.config.displayName = '';
    const { result } = renderHook(() =>
      useAgentActions({
        authMethod: null,
        editor,
        lock: makeLock('ok'),
        mutate: vi.fn(),
        permissions,
        snapshot,
      }),
    );

    act(() => result.current.save());

    expect(mocks.openReasonModal).not.toHaveBeenCalled();
    expect(mocks.service.appendVersion).not.toHaveBeenCalled();
    expect(editor.setSaveState).toHaveBeenCalledWith('failed');
    expect(mocks.toastError).toHaveBeenCalledWith('agentCatalog.save.invalid');
  });

  it('surfaces a default-switch preflight failure without opening the confirmation modal', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.findDefaultAdminAgent.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() =>
      useAgentActions({
        authMethod: null,
        editor: makeEditor(),
        lock: makeLock('ok'),
        mutate: vi.fn(),
        permissions,
        snapshot,
      }),
    );

    await act(async () => {
      await result.current.setDefaultInbox();
    });

    expect(mocks.openReasonModal).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('agentCatalog.toast.actionFailed');
    consoleError.mockRestore();
  });

  it('opens archive without pre-draining replacement candidates (picker loads independently)', async () => {
    // Replacement catalog is fetched inside ArchiveReplacementField, not as an archive preflight.
    mocks.fetchPublishedAdminAgentReplacements.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() =>
      useAgentActions({
        authMethod: null,
        editor: makeEditor(),
        lock: makeLock('ok'),
        mutate: vi.fn(),
        permissions,
        snapshot: { ...snapshot, identity: { ...snapshot.identity, isDefault: true } },
      }),
    );

    await act(async () => {
      await result.current.archive();
    });

    expect(mocks.openReasonModal).toHaveBeenCalledOnce();
    // No eager catalog drain before the modal mounts.
    expect(mocks.fetchPublishedAdminAgentReplacements).not.toHaveBeenCalled();
  });
});
