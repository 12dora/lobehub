// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { AgentDetailView } from './AgentDetailView';
import { deriveAdminAgentPermissions } from './controller';
import type { AdminAgentDetailOutput, AdminAgentDraft } from './types';

const validityMock = vi.hoisted(() => ({ value: { issues: [] as string[], ready: true } }));
const mocks = vi.hoisted(() => ({
  listVersions: vi.fn(),
  toastError: vi.fn(),
}));

beforeEach(() => {
  mocks.listVersions.mockReset();
  mocks.toastError.mockReset();
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: {
    capabilities: { rollouts: false },
    listVersions: mocks.listVersions,
  },
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
  Alert: ({ action, message }: { action?: ReactNode; message?: ReactNode }) => (
    <div>
      {message}
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
  toast: { error: mocks.toastError, success: vi.fn() },
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

const renderView = (
  editorDirty: boolean,
  permissionKeys: string[],
  detail: AdminAgentDetailOutput = snapshot,
) =>
  render(
    <AgentDetailView
      authMethod={null}
      editor={createEditor(editorDirty)}
      mutate={vi.fn() as any}
      permissions={deriveAdminAgentPermissions(permissionKeys)}
      snapshot={detail}
    />,
  );

const StatefulDetailView = ({ initial }: { initial: AdminAgentDetailOutput }) => {
  const [detail, setDetail] = useState(initial);
  const mutate = vi.fn(async (updater: unknown) => {
    if (typeof updater === 'function') {
      setDetail((current) => updater(current));
    }
    return undefined;
  });

  return (
    <AgentDetailView
      authMethod={null}
      editor={createEditor(false)}
      mutate={mutate as any}
      permissions={deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_READ])}
      snapshot={detail}
    />
  );
};

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

  it('keeps a retry action and surfaces feedback when loading more versions fails', async () => {
    mocks.listVersions.mockRejectedValueOnce(new Error('offline'));
    const partialSnapshot: AdminAgentDetailOutput = {
      ...snapshot,
      collectionMeta: {
        assignmentsNextCursor: null,
        assignmentsTruncated: false,
        rolloutsNextCursor: null,
        rolloutsTruncated: false,
        versionsNextCursor: 'next-page',
        versionsTruncated: true,
      },
    };
    renderView(false, [PLATFORM_PERMISSIONS.AGENT_READ], partialSnapshot);

    fireEvent.click(screen.getByText('agentCatalog.collection.loadMore'));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('agentCatalog.collection.loadFailed');
    });
    expect(screen.getByText('agentCatalog.collection.retry')).toBeTruthy();
    expect(mocks.listVersions).toHaveBeenCalledWith({
      agentId: 'agent-1',
      cursor: 'next-page',
      limit: 100,
    });
  });

  it('advances the real version cursor once, dedupes rows, and removes load-more at the end', async () => {
    const nextVersion = {
      ...snapshot.versions[0],
      checksum: 'd'.repeat(64),
      createdAt: new Date('2026-07-18T00:00:00Z'),
      id: 'version-2',
      version: '1.0.1',
    };
    mocks.listVersions.mockResolvedValueOnce({
      items: [snapshot.versions[0], nextVersion],
      nextCursor: null,
    });
    const partialSnapshot: AdminAgentDetailOutput = {
      ...snapshot,
      collectionMeta: {
        assignmentsNextCursor: null,
        assignmentsTruncated: false,
        rolloutsNextCursor: null,
        rolloutsTruncated: false,
        versionsNextCursor: 'next-page',
        versionsTruncated: true,
      },
    };
    render(<StatefulDetailView initial={partialSnapshot} />);

    const loadMore = screen.getByText('agentCatalog.collection.loadMore');
    fireEvent.click(loadMore);
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(screen.getByText('1.0.1')).toBeTruthy();
      expect(screen.queryByText('agentCatalog.collection.loadMore')).toBeNull();
    });
    expect(mocks.listVersions).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('1.0.0')).toHaveLength(1);
  });
});
