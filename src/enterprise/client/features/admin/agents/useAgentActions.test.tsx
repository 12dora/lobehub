// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminAgentDetailOutput } from './types';
import { useAgentActions } from './useAgentActions';
import type { RefreshLock } from './useRefreshLock';

const mocks = vi.hoisted(() => ({
  openReasonModal: vi.fn(),
  service: {
    archive: vi.fn(),
    get: vi.fn(),
    rollback: vi.fn(),
    save: vi.fn(),
    setDefaultInbox: vi.fn(),
  },
  fetchPublishedAdminAgentReplacements: vi.fn(),
  findDefaultAdminAgent: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
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
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
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
    mocks.toastSuccess.mockReset();
    mocks.toastWarning.mockReset();
  });

  it('routes rollback through the shared reauth modal with authMethod and a frozen CAS payload', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    mocks.service.rollback.mockResolvedValue({ agentId: 'agent-1', revision: 8, versionId: 'v1' });
    const { result } = renderHook(() =>
      useAgentActions({
        authMethod: 'better-auth',
        lock: makeLock('ok'),
        mutate,
        snapshot,
      }),
    );

    act(() => result.current.rollback('v1'));
    const config = lastModalConfig();
    expect(config.authMethod).toBe('better-auth');
    expect(config.buildPayload('do it')).toEqual({
      agentId: 'agent-1',
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 7,
      reason: 'do it',
      targetVersionId: 'v1',
    });

    await act(async () => {
      await config.onSubmit(config.buildPayload('do it'));
    });
    expect(mocks.service.rollback).toHaveBeenCalledOnce();
  });

  it('warns on deferred rollback invalidation without showing contradictory success', async () => {
    mocks.service.rollback.mockResolvedValue({
      agentId: 'agent-1',
      invalidationStatus: 'deferred',
      revision: 8,
      versionId: 'v1',
    });
    const { result } = renderHook(() =>
      useAgentActions({
        authMethod: null,
        lock: makeLock('ok'),
        mutate: vi.fn(),
        snapshot,
      }),
    );

    act(() => result.current.rollback('v1'));
    await act(async () => {
      await lastModalConfig().onSubmit(lastModalConfig().buildPayload('rollback'));
    });

    expect(mocks.toastWarning).toHaveBeenCalledWith('agentCatalog.toast.refreshDeferred');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('locks a second write after a refresh-failed rollback; the re-enabled write uses the NEW CAS', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    const lock = makeLock('fail');
    mocks.service.rollback.mockResolvedValue({ agentId: 'agent-1', revision: 8, versionId: 'v1' });
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useAgentActions>[0]) => useAgentActions(props),
      {
        initialProps: {
          authMethod: null,
          lock,
          mutate,
          snapshot,
        },
      },
    );

    act(() => result.current.rollback('v1'));
    await act(async () => {
      await lastModalConfig().onSubmit(lastModalConfig().buildPayload('reason'));
    });
    expect(mocks.service.rollback).toHaveBeenCalledOnce();
    expect(lock.isLocked()).toBe(true);

    // Second rollback while locked must NOT open a modal or call the service again.
    const modalCalls = mocks.openReasonModal.mock.calls.length;
    act(() => result.current.rollback('v1'));
    expect(mocks.openReasonModal.mock.calls.length).toBe(modalCalls);
    expect(mocks.service.rollback).toHaveBeenCalledOnce();

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
      lock,
      mutate,
      snapshot: advanced,
    });

    act(() => result.current.rollback('v1'));
    expect(mocks.openReasonModal.mock.calls.length).toBe(modalCalls + 1);
    // The re-enabled write uses the NEW CAS, never the stale pre-refresh values.
    const built = lastModalConfig().buildPayload('again');
    expect(built.expectedRevision).toBe(8);
    expect(built.expectedDraftToken).toBe('c'.repeat(64));
  });

  it('surfaces a default-switch preflight failure without opening the confirmation modal', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.findDefaultAdminAgent.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() =>
      useAgentActions({
        authMethod: null,
        lock: makeLock('ok'),
        mutate: vi.fn(),
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
        lock: makeLock('ok'),
        mutate: vi.fn(),
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
