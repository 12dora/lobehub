// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { deriveAdminAgentPermissions } from './controller';
import { RolloutPanel } from './RolloutPanel';
import type { AdminAgentDetailOutput } from './types';
import type { RefreshLock } from './useRefreshLock';

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  openModal: vi.fn(),
  retry: vi.fn(),
  rollback: vi.fn(),
}));

const unlockedLock = (): RefreshLock => ({
  abortWrite: vi.fn(),
  beginWrite: vi.fn(() => true),
  commitWrite: vi.fn(async () => undefined),
  isLocked: () => false,
  locked: false,
  markCommitted: vi.fn(),
  refreshFailed: false,
  resolveWrite: vi.fn(),
  retryRefresh: vi.fn(async () => undefined),
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: {
    cancelRollout: mocks.cancel,
    retryRollout: mocks.retry,
    rollbackRollout: mocks.rollback,
  },
}));
vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: mocks.openModal,
}));
vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', () => ({
  isAdminReauthRequiredError: (error: unknown) =>
    Boolean(
      error &&
      typeof error === 'object' &&
      (error as { code?: string }).code === 'ADMIN_REAUTH_REQUIRED',
    ),
}));
vi.mock('@lobehub/ui', () => ({
  Alert: ({
    action,
    description,
    message,
  }: {
    action?: ReactNode;
    description?: ReactNode;
    message?: ReactNode;
  }) => (
    <div>
      <span>{message}</span>
      <span>{description}</span>
      {action}
    </div>
  ),
  Block: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  toast: { error: vi.fn(), success: vi.fn() },
}));

const runningSnapshot: AdminAgentDetailOutput = {
  assignments: [],
  draftToken: 'a'.repeat(64),
  identity: {
    agentKey: 'inbox',
    currentVersionId: 'v1',
    draftSequence: 1,
    id: 'agent-1',
    isDefault: false,
    migrationRequired: false,
    revision: 1,
    status: 'published',
    systemKey: null,
  },
  rollouts: [
    {
      assignmentId: 'assignment-1',
      completed: 10,
      cursor: null,
      failed: 0,
      jobId: 'rollout-1',
      previousVersionId: null,
      revision: 1,
      status: 'running',
      targetVersionId: 'version-1',
      total: 100,
      updatedAt: new Date('2026-07-17T00:00:00Z'),
    },
  ],
  versions: [],
};

const lastModal = () =>
  mocks.openModal.mock.calls.at(-1)![0] as {
    authMethod?: string;
    buildPayload: (reason: string) => unknown;
    onSubmit: (payload: unknown) => Promise<void>;
  };

describe('RolloutPanel capability gate', () => {
  beforeEach(() => {
    mocks.cancel.mockReset();
    mocks.retry.mockReset();
    mocks.rollback.mockReset();
    mocks.openModal.mockReset();
  });

  it('shows a deferral notice and no rollout actions when the backend is unavailable', () => {
    render(
      <RolloutPanel
        authMethod={null}
        enabled={false}
        lock={unlockedLock()}
        permissions={deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_ASSIGN])}
        refresh={vi.fn()}
        snapshot={runningSnapshot}
      />,
    );

    expect(screen.getByText('agentCatalog.rollout.deferredTitle')).toBeTruthy();
    expect(screen.getByText('agentCatalog.rollout.deferred')).toBeTruthy();
    // A running rollout would otherwise render a cancel control — the gate must suppress it.
    expect(screen.queryByText('agentCatalog.rollout.cancel')).toBeNull();
  });

  it('renders live rollout actions when a client explicitly enables the capability', () => {
    render(
      <RolloutPanel
        enabled
        authMethod={null}
        lock={unlockedLock()}
        permissions={deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_ASSIGN])}
        refresh={vi.fn()}
        snapshot={runningSnapshot}
      />,
    );

    expect(screen.queryByText('agentCatalog.rollout.deferredTitle')).toBeNull();
    expect(screen.getByText('agentCatalog.rollout.cancel')).toBeTruthy();
  });

  it('offers an explicit reverse rollout only to publishers with a previous version', () => {
    render(
      <RolloutPanel
        enabled
        authMethod={null}
        lock={unlockedLock()}
        permissions={deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_PUBLISH])}
        refresh={vi.fn()}
        snapshot={{
          ...runningSnapshot,
          rollouts: [
            {
              ...runningSnapshot.rollouts[0],
              previousVersionId: 'version-0',
              status: 'completed',
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('agentCatalog.rollout.rollback')).toBeTruthy();
    expect(screen.queryByText('agentCatalog.rollout.retry')).toBeNull();
  });

  it('keeps loaded progress visible when live polling fails and exposes retry', () => {
    const refresh = vi.fn();
    const retryPoll = vi.fn();
    render(
      <RolloutPanel
        enabled
        authMethod={null}
        lock={unlockedLock()}
        permissions={deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_ASSIGN])}
        pollError={new Error('poll failed')}
        refresh={refresh}
        retryPoll={retryPoll}
        snapshot={runningSnapshot}
      />,
    );

    expect(screen.getByText('agentCatalog.rollout.pollFailed')).toBeTruthy();
    expect(screen.getByText('agentCatalog.rollout.pollRetry')).toBeTruthy();
    expect(screen.getByText('agentCatalog.rollout.cancel')).toBeTruthy();
    fireEvent.click(screen.getByText('agentCatalog.rollout.pollRetry'));
    expect(retryPoll).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('routes cancel/retry/rollback through the shared reauth modal with authMethod and frozen CAS', async () => {
    mocks.cancel
      .mockRejectedValueOnce(new Error('ADMIN_REAUTH_REQUIRED'))
      .mockResolvedValueOnce({} as never);
    const refresh = vi.fn().mockResolvedValue(runningSnapshot);
    render(
      <RolloutPanel
        enabled
        authMethod="better-auth"
        lock={unlockedLock()}
        permissions={deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_ASSIGN])}
        refresh={refresh}
        snapshot={runningSnapshot}
      />,
    );

    fireEvent.click(screen.getByText('agentCatalog.rollout.cancel'));
    const config = lastModal();
    expect(config.authMethod).toBe('better-auth');
    const payload = config.buildPayload('approved reason');
    expect(payload).toEqual({
      agentId: 'agent-1',
      expectedJobRevision: 1,
      expectedStatus: 'running',
      jobId: 'rollout-1',
      reason: 'approved reason',
    });

    // First attempt: reauth required — surface the error for the shared modal retry path.
    await expect(config.onSubmit(payload)).rejects.toThrow(/ADMIN_REAUTH_REQUIRED/);
    // Same frozen payload succeeds on the single retry (no re-open of the modal).
    await act(async () => {
      await config.onSubmit(payload);
    });
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
    expect(mocks.cancel).toHaveBeenNthCalledWith(1, payload);
    expect(mocks.cancel).toHaveBeenNthCalledWith(2, payload);
    expect(mocks.openModal).toHaveBeenCalledTimes(1);
  });

  it('routes rollback through the shared identity lock and keeps writes locked on failed refresh', async () => {
    mocks.rollback.mockResolvedValue({} as never);
    const beginWrite = vi.fn(() => true);
    const markCommitted = vi.fn();
    let lockedAfterRefresh = false;
    const commitWrite = vi.fn(async () => {
      // Simulate post-commit refresh failure: shared lock remains engaged for all writes.
      lockedAfterRefresh = true;
    });
    const lock: RefreshLock = {
      ...unlockedLock(),
      beginWrite,
      commitWrite,
      isLocked: () => lockedAfterRefresh,
      get locked() {
        return lockedAfterRefresh;
      },
      markCommitted,
    };
    render(
      <RolloutPanel
        enabled
        authMethod={null}
        lock={lock}
        refresh={vi.fn()}
        permissions={deriveAdminAgentPermissions([
          PLATFORM_PERMISSIONS.AGENT_ASSIGN,
          PLATFORM_PERMISSIONS.AGENT_PUBLISH,
        ])}
        snapshot={{
          ...runningSnapshot,
          rollouts: [
            {
              ...runningSnapshot.rollouts[0]!,
              previousVersionId: 'version-0',
              status: 'completed',
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByText('agentCatalog.rollout.rollback'));
    const config = lastModal();
    const payload = config.buildPayload('rollback');
    await act(async () => {
      await config.onSubmit(payload);
    });
    expect(beginWrite).toHaveBeenCalledOnce();
    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(markCommitted).toHaveBeenCalledOnce();
    expect(commitWrite).toHaveBeenCalledOnce();
    // Failed post-commit refresh leaves the shared lock engaged — further writes must gate.
    expect(lock.isLocked()).toBe(true);
  });

  it('retries rollback after reauth with the same frozen CAS while the write lock is held', async () => {
    // Real beginWrite lifecycle: first attempt locks; reauth retry must re-enter with the same
    // token (isLocked() stays true) rather than being rejected by an isLocked() guard in onSubmit.
    const reauthError = Object.assign(new Error('ADMIN_REAUTH_REQUIRED'), {
      code: 'ADMIN_REAUTH_REQUIRED',
    });
    mocks.rollback.mockRejectedValueOnce(reauthError).mockResolvedValueOnce({} as never);

    let locked = false;
    let activeToken: object | null = null;
    let committed = false;
    const beginWrite = vi.fn((token: object) => {
      if (!locked) {
        locked = true;
        activeToken = token;
        committed = false;
        return true;
      }
      return activeToken === token && !committed;
    });
    const markCommitted = vi.fn((token: object) => {
      if (activeToken === token) committed = true;
    });
    const commitWrite = vi.fn(async (token: object) => {
      if (activeToken !== token) return;
      committed = true;
      locked = false;
      activeToken = null;
    });
    const abortWrite = vi.fn((token: object) => {
      if (activeToken === token && !committed) {
        locked = false;
        activeToken = null;
      }
    });
    const lock: RefreshLock = {
      abortWrite,
      beginWrite,
      commitWrite,
      isLocked: () => locked,
      get locked() {
        return locked;
      },
      markCommitted,
      refreshFailed: false,
      resolveWrite: vi.fn(),
      retryRefresh: vi.fn(async () => undefined),
    };

    render(
      <RolloutPanel
        enabled
        authMethod="better-auth"
        lock={lock}
        refresh={vi.fn()}
        permissions={deriveAdminAgentPermissions([
          PLATFORM_PERMISSIONS.AGENT_ASSIGN,
          PLATFORM_PERMISSIONS.AGENT_PUBLISH,
        ])}
        snapshot={{
          ...runningSnapshot,
          rollouts: [
            {
              ...runningSnapshot.rollouts[0]!,
              previousVersionId: 'version-0',
              status: 'completed',
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByText('agentCatalog.rollout.rollback'));
    const config = lastModal();
    expect(config.authMethod).toBe('better-auth');
    const payload = config.buildPayload('approved rollback');
    expect(payload).toEqual({
      agentId: 'agent-1',
      expectedJobRevision: 1,
      expectedStatus: 'completed',
      jobId: 'rollout-1',
      reason: 'approved rollback',
      targetVersionId: 'version-0',
    });

    // First attempt: reauth required — lock stays open (no abortWrite).
    await expect(config.onSubmit(payload)).rejects.toMatchObject({ code: 'ADMIN_REAUTH_REQUIRED' });
    expect(beginWrite).toHaveBeenCalledTimes(1);
    expect(lock.isLocked()).toBe(true);
    expect(abortWrite).not.toHaveBeenCalled();

    // Single retry with the identical frozen payload must succeed through beginWrite re-entry.
    await act(async () => {
      await config.onSubmit(payload);
    });
    expect(mocks.rollback).toHaveBeenCalledTimes(2);
    expect(mocks.rollback).toHaveBeenNthCalledWith(1, payload);
    expect(mocks.rollback).toHaveBeenNthCalledWith(2, payload);
    expect(beginWrite).toHaveBeenCalledTimes(2);
    expect(beginWrite.mock.results[1]?.value).toBe(true);
    expect(markCommitted).toHaveBeenCalledOnce();
    expect(commitWrite).toHaveBeenCalledOnce();
    expect(mocks.openModal).toHaveBeenCalledTimes(1);
  });

  it('disables duplicate controls during mutation and surfaces a refresh failure', async () => {
    let resolveCancel!: () => void;
    mocks.cancel.mockReturnValueOnce(new Promise<void>((resolve) => (resolveCancel = resolve)));
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(
      <RolloutPanel
        enabled
        authMethod={null}
        lock={unlockedLock()}
        permissions={deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_ASSIGN])}
        refresh={refresh}
        snapshot={runningSnapshot}
      />,
    );
    fireEvent.click(screen.getByText('agentCatalog.rollout.cancel'));
    const config = lastModal();
    const payload = config.buildPayload('approved reason');
    let confirming!: Promise<void>;
    act(() => {
      confirming = config.onSubmit(payload);
    });
    await waitFor(() => expect(screen.getByText('agentCatalog.rollout.cancel')).toBeDisabled());
    resolveCancel();
    await act(async () => confirming);
    expect(screen.getByText('agentCatalog.rollout.refreshFailed')).toBeTruthy();
    expect(screen.getByText('agentCatalog.rollout.refreshRetry')).toBeTruthy();
  });
});
