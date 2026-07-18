// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { AssignmentPanel } from './AssignmentPanel';
import { deriveAdminAgentPermissions } from './controller';
import type { AdminAgentDetailOutput } from './types';

const editorMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: { startRollout: vi.fn() },
}));
vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: vi.fn(),
}));
vi.mock('./useAssignmentEditor', () => ({ useAssignmentEditor: () => editorMock.value }));
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
  Switch: (props: any) => <input type="checkbox" {...props} />,
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
const lock = {
  abortWrite: vi.fn(),
  beginWrite: () => true,
  commitWrite: vi.fn(async () => {}),
  isLocked: () => false,
  locked: false,
  markCommitted: vi.fn(),
  refreshFailed: false,
  resolveWrite: vi.fn(),
  retryRefresh: vi.fn(),
};

beforeEach(() => {
  editorMock.value = {
    busy: false,
    draft: {},
    edit: vi.fn(),
    editingId: undefined,
    enabled: true,
    locked: false,
    error: null,
    mode: 'optional',
    pinnedVersionId: null,
    preview: null,
    previewAssignment: vi.fn(),
    refreshFailed: false,
    remove: vi.fn(),
    resetForm: vi.fn(),
    retryRefresh: vi.fn(),
    setEnabled: vi.fn(),
    setMode: vi.fn(),
    setPinnedVersionId: vi.fn(),
    setTargetId: vi.fn(),
    setTargetType: vi.fn(),
    setVersionPolicy: vi.fn(),
    submit: vi.fn(),
    targetId: '',
    targetType: 'global',
    validationError: null,
    versionPolicy: 'latest_published',
  };
});

describe('AssignmentPanel', () => {
  it('exposes create + edit controls and gates Start rollout while the backend is unavailable', () => {
    render(
      <AssignmentPanel
        authMethod={null}
        lock={lock}
        mutate={vi.fn() as any}
        permissions={permissions}
        rolloutsEnabled={false}
        snapshot={snapshot}
      />,
    );

    expect(screen.getByText('agentCatalog.assignment.create')).toBeTruthy();
    expect(screen.getByText('agentCatalog.assignment.edit')).toBeTruthy();
    expect(screen.getByText('agentCatalog.rollout.start')).toBeDisabled();
  });

  it('enables Start rollout only when the capability is explicitly injected', () => {
    render(
      <AssignmentPanel
        rolloutsEnabled
        authMethod={null}
        lock={lock}
        mutate={vi.fn() as any}
        permissions={permissions}
        snapshot={snapshot}
      />,
    );
    expect(screen.getByText('agentCatalog.rollout.start')).not.toBeDisabled();
  });

  it('surfaces a distinct refresh-failed banner after a committed change', () => {
    editorMock.value.refreshFailed = true;
    render(
      <AssignmentPanel
        authMethod={null}
        lock={lock}
        mutate={vi.fn() as any}
        permissions={permissions}
        rolloutsEnabled={false}
        snapshot={snapshot}
      />,
    );
    expect(screen.getByText('agentCatalog.recovery.refreshFailed')).toBeTruthy();
  });
});
