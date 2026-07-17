// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { AgentDetailView } from './AgentDetailView';
import { deriveAdminAgentPermissions } from './controller';
import type { AdminAgentDetailOutput, AdminAgentDraft } from './types';

const validityMock = vi.hoisted(() => ({ value: { issues: [] as string[], ready: true } }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: { capabilities: { rollouts: false } },
}));
vi.mock('./useAgentActions', () => ({
  useAgentActions: () => ({
    archive: vi.fn(),
    publish: vi.fn(),
    refreshFailed: false,
    retryRefresh: vi.fn(),
    rollback: vi.fn(),
    save: vi.fn(),
    setDefaultInbox: vi.fn(),
  }),
}));
vi.mock('./useRefreshLock', () => ({
  useRefreshLock: () => ({
    isLocked: () => false,
    refreshFailed: false,
    retryRefresh: vi.fn(),
    syncAfterCommit: vi.fn(),
  }),
}));
vi.mock('./AgentEditorFields', () => ({ AgentEditorFields: () => <div>editor-fields</div> }));
vi.mock('./DependencyEditor', async () => {
  const { useEffect } = await import('react');
  return {
    DependencyEditor: ({ onValidityChange }: { onValidityChange?: (v: unknown) => void }) => {
      useEffect(() => {
        onValidityChange?.(validityMock.value);
      }, [onValidityChange]);
      return <div>dependency-editor</div>;
    },
  };
});
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

const model = {
  modelKey: 'model',
  providerChecksum: 'a'.repeat(64),
  providerKey: 'provider',
  providerRevision: 1,
};

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
  dependencies: { connectors: [], model, skills: [] },
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
      dependencySnapshot: { connectors: [], model, skills: [] },
      id: 'version-1',
      version: '1.0.0',
    },
  ],
};

const createEditor = (dirty: boolean): any => ({
  conflict: false,
  dirty,
  discard: vi.fn(),
  draft,
  markSaved: vi.fn(),
  persistState: null,
  saveState: dirty ? 'dirty' : 'idle',
  setConflict: vi.fn(),
  setSaveState: vi.fn(),
  updateDraft: vi.fn(),
});

const renderView = (editorDirty: boolean, permissionKeys: string[]) =>
  render(
    <AgentDetailView
      authMethod={null}
      editor={createEditor(editorDirty)}
      mutate={vi.fn() as any}
      permissions={deriveAdminAgentPermissions(permissionKeys)}
      snapshot={snapshot}
    />,
  );

describe('AgentDetailView write gating', () => {
  it('keeps a read-only auditor on a real detail surface without mutation buttons', () => {
    validityMock.value = { issues: [], ready: true };
    renderView(false, [PLATFORM_PERMISSIONS.AGENT_READ]);
    expect(screen.getByText('agentCatalog.readOnly.badge')).toBeTruthy();
    expect(screen.queryByText('agentCatalog.action.saveVersion')).toBeNull();
    expect(screen.queryByText('agentCatalog.archive.submit')).toBeNull();
  });

  it('allows saving but disables destructive actions while the draft is dirty and deps are current', () => {
    validityMock.value = { issues: [], ready: true };
    renderView(true, [
      PLATFORM_PERMISSIONS.AGENT_DELETE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
    ]);
    expect(screen.getByText('agentCatalog.action.saveVersion')).not.toBeDisabled();
    expect(screen.getByText('agentCatalog.archive.submit')).toBeDisabled();
  });

  it('blocks save until the dependencies validate against the current catalog', () => {
    validityMock.value = { issues: ['agentCatalog.dependency.issues.modelStale'], ready: false };
    renderView(true, [PLATFORM_PERMISSIONS.AGENT_UPDATE]);
    expect(screen.getByText('agentCatalog.action.saveVersion')).toBeDisabled();
  });
});
