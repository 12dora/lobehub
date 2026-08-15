// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { AgentDetailView } from './AgentDetailView';
import { deriveAdminAgentPermissions } from './controller';
import type { AdminAgentDetailOutput, AdminAgentEditorValue } from './types';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  beginWrite: vi.fn(),
  commitWrite: vi.fn(),
  listVersions: vi.fn(),
  markCommitted: vi.fn(),
  openEditor: vi.fn(),
  toastError: vi.fn(),
}));

beforeEach(() => {
  mocks.archive.mockReset();
  mocks.beginWrite.mockReset().mockReturnValue(true);
  mocks.commitWrite.mockReset().mockResolvedValue(undefined);
  mocks.listVersions.mockReset();
  mocks.markCommitted.mockReset();
  mocks.openEditor.mockReset();
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
    archive: mocks.archive,
    refreshFailed: false,
    retryRefresh: vi.fn(),
    rollback: vi.fn(),
    setDefaultInbox: vi.fn(),
  }),
}));
vi.mock('./openAgentEditorModal', () => ({
  openAgentEditorModal: (...args: unknown[]) => mocks.openEditor(...args),
}));
vi.mock('./useRefreshLock', () => ({
  useRefreshLock: () => ({
    abortWrite: vi.fn(),
    beginWrite: mocks.beginWrite,
    commitWrite: mocks.commitWrite,
    isLocked: () => false,
    locked: false,
    markCommitted: mocks.markCommitted,
    refreshFailed: false,
    resolveWrite: vi.fn(),
    retryRefresh: vi.fn(),
  }),
}));
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

const draft: AdminAgentEditorValue = {
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

const renderView = (permissionKeys: string[], detail: AdminAgentDetailOutput = snapshot) =>
  render(
    <AgentDetailView
      authMethod={null}
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
      mutate={mutate as any}
      permissions={deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_READ])}
      snapshot={detail}
    />
  );
};

describe('AgentDetailView write gating', () => {
  it('keeps a read-only auditor on a real detail surface without mutation buttons', () => {
    renderView([PLATFORM_PERMISSIONS.AGENT_READ]);
    expect(screen.getByText('agentCatalog.readOnly.badge')).toBeTruthy();
    expect(screen.queryByText('agentCatalog.action.edit')).toBeNull();
    expect(screen.queryByText('agentCatalog.archive.submit')).toBeNull();
    // The version history is still readable, and rollback stays hidden without publish rights.
    expect(screen.getByText('agentCatalog.versions.title')).toBeTruthy();
    expect(screen.queryByText('agentCatalog.rollback.submit')).toBeNull();
  });

  it('withholds Edit from an operator who can update but cannot publish', () => {
    renderView([PLATFORM_PERMISSIONS.AGENT_UPDATE]);
    expect(screen.queryByText('agentCatalog.action.edit')).toBeNull();
  });

  it('opens the shared editor with the live snapshot and refreshes the detail after a save', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentDetailView
        authMethod={null}
        mutate={mutate as any}
        snapshot={snapshot}
        permissions={deriveAdminAgentPermissions([
          PLATFORM_PERMISSIONS.AGENT_PUBLISH,
          PLATFORM_PERMISSIONS.AGENT_UPDATE,
        ])}
      />,
    );
    const edit = screen.getByText('agentCatalog.action.edit');
    expect(edit).not.toBeDisabled();

    fireEvent.click(edit);
    expect(mocks.openEditor).toHaveBeenCalledOnce();
    const [config] = mocks.openEditor.mock.calls[0] as [
      {
        agent: AdminAgentDetailOutput;
        onSaved: (output: unknown) => Promise<void>;
      },
    ];
    expect(config.agent.identity.id).toBe('agent-1');

    const output = {
      draftToken: 'e'.repeat(64),
      identity: { ...snapshot.identity, currentVersionId: 'version-2', revision: 3 },
      invalidationStatus: 'delivered',
      version: { ...snapshot.versions[0]!, id: 'version-2', version: '1.0.1' },
    };
    await config.onSaved(output);

    // The committed output is applied to this page's cache BEFORE revalidating…
    const [apply, options] = mutate.mock.calls[0] as [
      (current: AdminAgentDetailOutput) => AdminAgentDetailOutput,
      { revalidate: boolean },
    ];
    expect(options).toEqual({ revalidate: false });
    const applied = apply(snapshot);
    expect(applied.draftToken).toBe(output.draftToken);
    expect(applied.identity.revision).toBe(3);
    expect(applied.versions[0]!.version).toBe('1.0.1');
    // …and the shared gate then verifies the refresh, so a failed one locks dependent writes.
    expect(mocks.markCommitted).toHaveBeenCalled();
    expect(mocks.commitWrite).toHaveBeenCalled();
  });

  it('enables archive for a delete-capable admin without any dirty-editor coupling', () => {
    renderView([PLATFORM_PERMISSIONS.AGENT_DELETE]);
    expect(screen.getByText('agentCatalog.archive.submit')).not.toBeDisabled();
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
    renderView([PLATFORM_PERMISSIONS.AGENT_READ], partialSnapshot);

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
