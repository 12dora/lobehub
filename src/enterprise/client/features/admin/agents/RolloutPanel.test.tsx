// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { deriveAdminAgentPermissions } from './controller';
import { RolloutPanel } from './RolloutPanel';
import type { AdminAgentDetailOutput } from './types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: { cancelRollout: vi.fn(), retryRollout: vi.fn() },
}));
vi.mock('./openAgentReasonModal', () => ({ openAgentReasonModal: vi.fn() }));
vi.mock('@lobehub/ui', () => ({
  Alert: ({ description, message }: { description?: ReactNode; message?: ReactNode }) => (
    <div>
      <span>{message}</span>
      <span>{description}</span>
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
      revision: 1,
      status: 'running',
      total: 100,
      updatedAt: new Date('2026-07-17T00:00:00Z'),
    },
  ],
  versions: [],
};

describe('RolloutPanel capability gate', () => {
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
});
