// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { deriveAdminAgentPermissions } from './controller';
import { RolloutPanel } from './RolloutPanel';
import type { AdminAgentDetailOutput } from './types';

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  openModal: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: {
    cancelRollout: mocks.cancel,
    retryRollout: vi.fn(),
    rollbackRollout: vi.fn(),
  },
}));
vi.mock('./openAgentReasonModal', () => ({ openAgentReasonModal: mocks.openModal }));
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

describe('RolloutPanel capability gate', () => {
  beforeEach(() => {
    mocks.cancel.mockReset();
    mocks.openModal.mockReset();
  });

  it('shows a deferral notice and no rollout actions when the backend is unavailable', () => {
    render(
      <RolloutPanel
        enabled={false}
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
    render(
      <RolloutPanel
        enabled
        permissions={deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_ASSIGN])}
        pollError={new Error('poll failed')}
        refresh={vi.fn()}
        snapshot={runningSnapshot}
      />,
    );

    expect(screen.getByText('agentCatalog.rollout.pollFailed')).toBeTruthy();
    expect(screen.getByText('agentCatalog.rollout.pollRetry')).toBeTruthy();
    expect(screen.getByText('agentCatalog.rollout.cancel')).toBeTruthy();
  });

  it('disables duplicate controls during mutation and surfaces a refresh failure', async () => {
    let resolveCancel!: () => void;
    mocks.cancel.mockReturnValueOnce(new Promise<void>((resolve) => (resolveCancel = resolve)));
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(
      <RolloutPanel
        enabled
        permissions={deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_ASSIGN])}
        refresh={refresh}
        snapshot={runningSnapshot}
      />,
    );
    fireEvent.click(screen.getByText('agentCatalog.rollout.cancel'));
    const options = mocks.openModal.mock.calls[0]![0] as {
      onConfirm: (reason: string) => Promise<void>;
    };
    let confirming!: Promise<void>;
    act(() => {
      confirming = options.onConfirm('approved reason');
    });
    await waitFor(() => expect(screen.getByText('agentCatalog.rollout.cancel')).toBeDisabled());
    resolveCancel();
    await act(async () => confirming);
    expect(screen.getByText('agentCatalog.rollout.refreshFailed')).toBeTruthy();
    expect(screen.getByText('agentCatalog.rollout.refreshRetry')).toBeTruthy();
  });
});
