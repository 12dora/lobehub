// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { AssignmentPanel } from './AssignmentPanel';
import { deriveAdminAgentPermissions } from './controller';
import type { AdminAgentDetailOutput } from './types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/services/adminAgents', () => ({ adminAgentsService: {} }));
vi.mock('./openAgentReasonModal', () => ({ openAgentReasonModal: vi.fn() }));
vi.mock('./useAssignmentEditor', () => ({
  useAssignmentEditor: () => ({
    busy: false,
    createAssignment: vi.fn(),
    error: null,
    mode: 'optional',
    preview: null,
    previewAssignment: vi.fn(),
    reason: '',
    setMode: vi.fn(),
    setReason: vi.fn(),
    setTargetId: vi.fn(),
    setTargetType: vi.fn(),
    targetId: '__global__',
    targetType: 'global',
  }),
}));
vi.mock('@lobehub/ui', () => ({
  Alert: ({ message }: { message?: ReactNode }) => <div>{message}</div>,
  Block: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Input: (props: any) => <input {...props} />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Select: (props: any) => <select {...props} />,
  toast: { error: vi.fn(), success: vi.fn() },
}));

const snapshot: AdminAgentDetailOutput = {
  assignments: [
    {
      agentId: 'agent-1',
      enabled: true,
      id: 'assignment-1',
      mode: 'optional',
      pinnedVersionId: null,
      targetId: '__global__',
      targetType: 'global',
      versionPolicy: 'latest_published',
    },
  ],
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
  rollouts: [],
  versions: [],
};

const permissions = deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_ASSIGN]);

describe('AssignmentPanel rollout start gate', () => {
  it('disables the Start rollout action while the rollout backend is unavailable', () => {
    render(
      <AssignmentPanel
        permissions={permissions}
        refresh={vi.fn()}
        rolloutsEnabled={false}
        snapshot={snapshot}
      />,
    );

    expect(screen.getByText('agentCatalog.rollout.start')).toBeDisabled();
  });

  it('enables the Start rollout action when the capability is explicitly injected', () => {
    render(
      <AssignmentPanel
        rolloutsEnabled
        permissions={permissions}
        refresh={vi.fn()}
        snapshot={snapshot}
      />,
    );

    expect(screen.getByText('agentCatalog.rollout.start')).not.toBeDisabled();
  });
});
