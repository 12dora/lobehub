// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { AgentDetailView } from './AgentDetailView';
import { deriveAdminAgentPermissions } from './controller';
import type { AdminAgentDetailOutput, AdminAgentDraft } from './types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: { capabilities: { rollouts: false } },
}));
vi.mock('./openAgentReasonModal', () => ({ openAgentReasonModal: vi.fn() }));
vi.mock('./openArchiveAgentModal', () => ({ openArchiveAgentModal: vi.fn() }));
vi.mock('./useAdminAgents', () => ({ fetchAllAdminAgents: vi.fn() }));
vi.mock('./AgentEditorFields', () => ({ AgentEditorFields: () => <div>editor-fields</div> }));
vi.mock('./AssignmentPanel', () => ({ AssignmentPanel: () => <div>assignment-panel</div> }));
vi.mock('./RolloutPanel', () => ({ RolloutPanel: () => <div>rollout-panel</div> }));
vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ actions, children }: { actions?: ReactNode; children?: ReactNode }) => (
    <main>
      {actions}
      {children}
    </main>
  ),
}));
vi.mock('../primitives/StatusBadge', () => ({ default: () => <span>status</span> }));
vi.mock('@lobehub/ui', () => ({
  Alert: ({ message }: { message?: ReactNode }) => <div>{message}</div>,
  Block: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  toast: { error: vi.fn(), success: vi.fn() },
}));

const draft: AdminAgentDraft = {
  config: {
    avatar: null,
    backgroundColor: null,
    description: null,
    displayName: 'Research',
    modelParameters: {},
    openingMessage: null,
    openingQuestions: [],
    systemRole: 'Research carefully.',
    tags: [],
  },
  dependencySnapshot: {
    connectors: [],
    model: {
      modelKey: 'model',
      providerChecksum: 'a'.repeat(64),
      providerKey: 'provider',
      providerRevision: 1,
    },
    skills: [],
  },
  version: '1.0.1',
};

const snapshot: AdminAgentDetailOutput = {
  assignments: [],
  draftToken: 'b'.repeat(64),
  identity: {
    agentKey: 'research',
    currentVersionId: 'version-1',
    draftSequence: 1,
    id: 'agent-1',
    isDefault: false,
    migrationRequired: false,
    revision: 2,
    status: 'published',
    systemKey: null,
  },
  rollouts: [],
  versions: [
    {
      agentId: 'agent-1',
      checksum: 'c'.repeat(64),
      config: draft.config,
      createdAt: new Date('2026-07-17T00:00:00Z'),
      createdBy: 'admin-1',
      dependencySnapshot: draft.dependencySnapshot,
      id: 'version-1',
      version: '1.0.0',
    },
  ],
};

const createEditor = (dirty: boolean) => ({
  conflict: false,
  dirty,
  discard: vi.fn(),
  draft,
  markSaved: vi.fn(),
  saveState: dirty ? ('dirty' as const) : ('idle' as const),
  setConflict: vi.fn(),
  setSaveState: vi.fn(),
  updateDraft: vi.fn(),
});

describe('AgentDetailView write gating', () => {
  it('keeps a read-only auditor on a real detail surface without mutation buttons', () => {
    render(
      <AgentDetailView
        editor={createEditor(false)}
        permissions={deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_READ])}
        refresh={vi.fn()}
        snapshot={snapshot}
      />,
    );

    expect(screen.getByText('agentCatalog.readOnly.badge')).toBeTruthy();
    expect(screen.queryByText('agentCatalog.action.saveVersion')).toBeNull();
    expect(screen.queryByText('agentCatalog.archive.submit')).toBeNull();
    expect(screen.queryByText('agentCatalog.defaultSwitch.submit')).toBeNull();
  });

  it('allows saving but disables every pointer/destructive action while the draft is dirty', () => {
    const permissions = deriveAdminAgentPermissions([
      PLATFORM_PERMISSIONS.AGENT_DELETE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
    ]);
    render(
      <AgentDetailView
        editor={createEditor(true)}
        permissions={permissions}
        refresh={vi.fn()}
        snapshot={snapshot}
      />,
    );

    expect(screen.getByText('agentCatalog.action.saveVersion')).not.toBeDisabled();
    expect(screen.getByText('agentCatalog.archive.submit')).toBeDisabled();
    expect(screen.getByText('agentCatalog.defaultSwitch.submit')).toBeDisabled();
  });
});
