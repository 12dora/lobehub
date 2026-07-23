// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import SkillDetailPage from './SkillDetailPage';

const mocks = vi.hoisted(() => ({
  dependentData: undefined as any,
  dependentError: new Error('dependents offline') as unknown,
  dependentInputs: [] as unknown[],
  dependentLoading: false,
  dependentMutate: vi.fn(),
  dependentPageErrorOnCursor: false,
  detailMutate: vi.fn(),
  editor: vi.fn(),
  permissions: [] as string[],
  skillActions: vi.fn(),
  versionDetailData: undefined as any,
  versionDetailError: new Error('version offline') as unknown,
  versionDetailMutate: vi.fn(),
  versionListData: undefined as any,
  versionListError: new Error('versions offline') as unknown,
  versionListInputs: [] as unknown[],
  versionListLoading: false,
  versionsMutate: vi.fn(),
  versionPageErrorOnCursor: false,
}));

const summary = {
  checksum: 'a'.repeat(64),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  createdBy: 'admin-1',
  id: 'version-1',
  lastPublishedRevision: 2,
  skillId: 's1',
  validation: null,
  version: '1.0.0',
};

const detail = {
  baseRevision: 2,
  draft: {
    allowBuiltinOverride: false,
    currentVersionId: 'version-1',
    description: 'Description',
    displayName: 'Skill One',
    distribution: 'default' as const,
    draftSequence: 2,
    enabled: true,
    id: 's1',
    revision: 2,
    skillKey: 'skill.one',
    source: 'uploaded' as const,
    status: 'published' as const,
  },
  draftToken: 'b'.repeat(64),
  latestVersion: summary,
  publishedVersion: summary,
};

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: null, permissions: mocks.permissions }),
}));

vi.mock('@/components/AsyncBoundary', () => ({
  default: ({ children, data, error, isLoading, onRetry }: any) => {
    if (isLoading && data === undefined) return <div role="status">async-loading</div>;
    if (error && data === undefined)
      return (
        <div role="alert">
          async-error<button onClick={onRetry}>async-retry</button>
        </div>
      );
    return children;
  },
}));

vi.mock('@/features/NavPanel/components/SkeletonList', () => ({
  default: () => <div>skeleton-list</div>,
}));

vi.mock('./hooks/useAdminSkills', () => ({
  useFetchAdminSkill: () => ({
    data: detail,
    error: undefined,
    isLoading: false,
    mutate: mocks.detailMutate,
  }),
  useFetchAdminSkillDependents: (input: unknown) => {
    mocks.dependentInputs.push(structuredClone(input));
    const cursor = (input as { cursor?: string }).cursor;
    return {
      data: mocks.dependentData,
      error:
        mocks.dependentPageErrorOnCursor && cursor
          ? new Error('dependent page offline')
          : mocks.dependentError,
      isLoading: mocks.dependentLoading,
      mutate: mocks.dependentMutate,
    };
  },
  useFetchAdminSkillVersion: () => ({
    data: mocks.versionDetailData,
    error: mocks.versionDetailError,
    isLoading: false,
    mutate: mocks.versionDetailMutate,
  }),
  useFetchAdminSkillVersions: (input: unknown) => {
    mocks.versionListInputs.push(structuredClone(input));
    const cursor = (input as { cursor?: string }).cursor;
    return {
      data: mocks.versionListData,
      error:
        mocks.versionPageErrorOnCursor && cursor
          ? new Error('version page offline')
          : mocks.versionListError,
      isLoading: mocks.versionListLoading,
      mutate: mocks.versionsMutate,
    };
  },
}));

vi.mock('./hooks/useSkillEditor', () => ({ useSkillEditor: mocks.editor }));
vi.mock('./hooks/useSkillActions', () => ({ useSkillActions: mocks.skillActions }));
vi.mock('./SkillIdentityEditor', () => ({ default: () => <div>identity-editor</div> }));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ extra, message }: { extra?: ReactNode; message?: ReactNode }) => (
    <div role="alert">
      {message}
      {extra}
    </div>
  ),
  Empty: ({ description }: { description?: ReactNode }) => <div>{description}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ as: Component = 'span', children, ...props }: any) => (
    <Component {...props}>{children}</Component>
  ),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, type: _type, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ actions, banner, children, title }: any) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {banner}
      {children}
    </main>
  ),
}));
vi.mock('../primitives/RevisionBanner', () => ({ default: () => <div>revision-banner</div> }));
vi.mock('../primitives/StatusBadge', () => ({ default: () => <span>status</span> }));

describe('SkillDetailPage independent async states', () => {
  beforeEach(() => {
    mocks.dependentMutate.mockReset();
    mocks.dependentData = undefined;
    mocks.dependentError = new Error('dependents offline');
    mocks.dependentInputs.length = 0;
    mocks.dependentLoading = false;
    mocks.dependentPageErrorOnCursor = false;
    mocks.detailMutate.mockReset();
    mocks.editor.mockReset();
    mocks.editor.mockReturnValue({
      actionError: null,
      baseDraft: null,
      conflict: false,
      dirty: false,
      draft: null,
      persistenceStatus: 'saved',
      rebaseConflicts: [],
      saveState: 'idle',
    });
    mocks.skillActions.mockReset();
    mocks.skillActions.mockReturnValue({
      actionLoading: null,
      canPublishSelected: false,
      openArchive: vi.fn(),
      openCreateVersion: vi.fn(),
      openPublish: vi.fn(),
      openRollback: vi.fn(),
      openSaveIdentity: vi.fn(),
      openValidate: vi.fn(),
      refreshFailed: false,
      retryRefresh: vi.fn(),
    });
    mocks.permissions = [PLATFORM_PERMISSIONS.SKILL_READ];
    mocks.versionDetailMutate.mockReset();
    mocks.versionDetailData = undefined;
    mocks.versionDetailError = new Error('version offline');
    mocks.versionListData = undefined;
    mocks.versionListError = new Error('versions offline');
    mocks.versionListInputs.length = 0;
    mocks.versionListLoading = false;
    mocks.versionPageErrorOnCursor = false;
    mocks.versionsMutate.mockReset();
  });

  it('shows version, version-content, and dependents errors independently with retry', () => {
    render(
      <MemoryRouter initialEntries={['/admin/skills/s1']}>
        <Routes>
          <Route element={<SkillDetailPage />} path="/admin/skills/:id" />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('skillCatalog.detail.versions.error')).toBeTruthy();
    expect(screen.getByText('skillCatalog.detail.dependents.error')).toBeTruthy();
    expect(screen.getByText('async-error')).toBeTruthy();
    expect(mocks.editor).toHaveBeenCalledWith(detail, false);
    expect(screen.queryByText('skillCatalog.version.create')).toBeNull();
    expect(screen.queryByText('skillCatalog.actions.archive.label')).toBeNull();

    const retryButtons = screen.getAllByText('skillCatalog.actions.retry');
    fireEvent.click(retryButtons[0]);
    fireEvent.click(retryButtons[1]);
    fireEvent.click(screen.getByText('async-retry'));

    expect(mocks.versionsMutate).toHaveBeenCalledTimes(1);
    expect(mocks.dependentMutate).toHaveBeenCalledTimes(1);
    expect(mocks.versionDetailMutate).toHaveBeenCalledTimes(1);
  });

  it('renders validation codes through i18n and keeps raw messages in technical details', () => {
    const rawMessage = 'Raw server validation text';
    mocks.versionListError = undefined;
    mocks.versionListData = { items: [summary], nextCursor: null };
    mocks.versionDetailError = undefined;
    mocks.versionDetailData = {
      ...summary,
      content: '# content',
      contentRef: null,
      manifest: {
        description: 'Description',
        displayName: 'Skill One',
        localizedDescriptions: {},
        localizedDisplayNames: {},
        permissions: {
          filesystem: 'none',
          network: { allowedHosts: [], enabled: false },
          tools: { allow: [] },
        },
        skillDependencies: [],
        toolDependencies: [],
      },
      resources: [],
      validation: {
        issues: [
          {
            code: 'permissions_invalid',
            message: rawMessage,
            path: ['manifest', 'permissions'],
            severity: 'error',
          },
        ],
        validatedAt: new Date(0),
        validatorVersion: 'v1',
      },
    };
    mocks.dependentError = undefined;
    mocks.dependentData = { items: [], nextCursor: null };

    render(
      <MemoryRouter initialEntries={['/admin/skills/s1']}>
        <Routes>
          <Route element={<SkillDetailPage />} path="/admin/skills/:id" />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('skillCatalog.validation.issue.permissions_invalid')).toBeTruthy();
    expect(screen.getByText(rawMessage).closest('details')).toBeTruthy();
    expect(screen.getByText('skillCatalog.validation.technicalDetails')).toBeTruthy();
  });

  it('passes independent version and dependent cursors back to their server hooks', async () => {
    mocks.versionListError = undefined;
    mocks.versionListData = { items: [summary], nextCursor: 'version-cursor-2' };
    mocks.dependentError = undefined;
    mocks.dependentData = {
      items: [{ id: 'agent-1', key: 'agent.one', name: 'Agent One', type: 'agent', version: '1' }],
      nextCursor: 'dependent-cursor-2',
    };
    render(
      <MemoryRouter initialEntries={['/admin/skills/s1']}>
        <Routes>
          <Route element={<SkillDetailPage />} path="/admin/skills/:id" />
        </Routes>
      </MemoryRouter>,
    );

    const nextButtons = screen.getAllByText('skillCatalog.pagination.next');
    fireEvent.click(nextButtons[0]);
    fireEvent.click(nextButtons[1]);

    await waitFor(() => {
      expect(mocks.versionListInputs.at(-1)).toMatchObject({ cursor: 'version-cursor-2' });
      expect(mocks.dependentInputs.at(-1)).toMatchObject({ cursor: 'dependent-cursor-2' });
    });
  });

  it('ignores rapid double-clicks on detail pagers so cursors do not stack twice', async () => {
    mocks.versionListError = undefined;
    mocks.versionListData = { items: [summary], nextCursor: 'version-cursor-2' };
    mocks.versionListLoading = false;
    mocks.dependentError = undefined;
    mocks.dependentData = {
      items: [{ id: 'agent-1', key: 'agent.one', name: 'Agent One', type: 'agent', version: '1' }],
      nextCursor: 'dependent-cursor-2',
    };
    mocks.dependentLoading = false;
    render(
      <MemoryRouter initialEntries={['/admin/skills/s1']}>
        <Routes>
          <Route element={<SkillDetailPage />} path="/admin/skills/:id" />
        </Routes>
      </MemoryRouter>,
    );

    const nextButtons = screen.getAllByText('skillCatalog.pagination.next');
    // Triple-click each Next; goNext is idempotent for the same cursor token.
    fireEvent.click(nextButtons[0]);
    fireEvent.click(nextButtons[0]);
    fireEvent.click(nextButtons[0]);
    fireEvent.click(nextButtons[1]);
    fireEvent.click(nextButtons[1]);
    fireEvent.click(nextButtons[1]);

    await waitFor(() => {
      expect(mocks.versionListInputs.at(-1)).toMatchObject({ cursor: 'version-cursor-2' });
      expect(mocks.dependentInputs.at(-1)).toMatchObject({ cursor: 'dependent-cursor-2' });
    });

    // One Previous from each pager returns to page 1 (no duplicate stack entries).
    const previousButtons = screen.getAllByText('skillCatalog.pagination.previous');
    fireEvent.click(previousButtons[0]);
    fireEvent.click(previousButtons[1]);
    await waitFor(() => {
      expect(mocks.versionListInputs.at(-1)).toMatchObject({ cursor: undefined });
      expect(mocks.dependentInputs.at(-1)).toMatchObject({ cursor: undefined });
    });
  });

  it('keeps prior sub-list results and Previous when later cursor pages fail', async () => {
    mocks.versionListError = undefined;
    mocks.versionListData = { items: [summary], nextCursor: 'version-cursor-2' };
    mocks.versionPageErrorOnCursor = true;
    mocks.dependentError = undefined;
    mocks.dependentData = {
      items: [{ id: 'agent-1', key: 'agent.one', name: 'Agent One', type: 'agent', version: '1' }],
      nextCursor: 'dependent-cursor-2',
    };
    mocks.dependentPageErrorOnCursor = true;
    render(
      <MemoryRouter initialEntries={['/admin/skills/s1']}>
        <Routes>
          <Route element={<SkillDetailPage />} path="/admin/skills/:id" />
        </Routes>
      </MemoryRouter>,
    );

    const nextButtons = screen.getAllByText('skillCatalog.pagination.next');
    fireEvent.click(nextButtons[0]);
    fireEvent.click(nextButtons[1]);

    await waitFor(() => {
      expect(screen.getByText('skillCatalog.detail.versions.pageError')).toBeTruthy();
      expect(screen.getByText('skillCatalog.detail.dependents.pageError')).toBeTruthy();
    });
    expect(
      screen
        .getAllByText('skillCatalog.pagination.previous')
        .every((button) => !(button as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(
      screen
        .getAllByText('skillCatalog.pagination.next')
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    const retryButtons = screen.getAllByText('skillCatalog.actions.retry');
    fireEvent.click(retryButtons[0]);
    fireEvent.click(retryButtons[1]);
    expect(mocks.versionsMutate).toHaveBeenCalledTimes(1);
    expect(mocks.dependentMutate).toHaveBeenCalledTimes(1);
  });

  it('uses shape-matched skeleton lists for both sub-resource first loads', () => {
    mocks.versionListError = undefined;
    mocks.versionListLoading = true;
    mocks.dependentError = undefined;
    mocks.dependentLoading = true;
    render(
      <MemoryRouter initialEntries={['/admin/skills/s1']}>
        <Routes>
          <Route element={<SkillDetailPage />} path="/admin/skills/:id" />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getAllByText('skeleton-list')).toHaveLength(2);
  });

  it('renders every eligible write control visibly disabled during committed refresh lock', () => {
    mocks.permissions = [
      PLATFORM_PERMISSIONS.SKILL_READ,
      PLATFORM_PERMISSIONS.SKILL_UPDATE,
      PLATFORM_PERMISSIONS.SKILL_PUBLISH,
      PLATFORM_PERMISSIONS.SKILL_DELETE,
    ];
    const identity = {
      description: 'Description',
      displayName: 'Skill One',
      distribution: 'default' as const,
      enabled: true,
    };
    mocks.editor.mockReturnValue({
      actionError: 'skillCatalog.refresh.failed',
      baseDraft: { identity, versionDraft: null },
      conflict: false,
      dirty: false,
      draft: { identity, versionDraft: null },
      persistenceStatus: 'saved',
      rebaseConflicts: [],
      saveState: 'idle',
    });
    mocks.skillActions.mockReturnValue({
      actionLoading: null,
      canPublishSelected: true,
      openArchive: vi.fn(),
      openCreateVersion: vi.fn(),
      openPublish: vi.fn(),
      openRollback: vi.fn(),
      openSaveIdentity: vi.fn(),
      openValidate: vi.fn(),
      refreshFailed: true,
      retryRefresh: vi.fn(),
    });
    mocks.versionListError = undefined;
    mocks.versionListData = { items: [summary], nextCursor: null };
    mocks.versionDetailError = undefined;
    mocks.versionDetailData = {
      ...summary,
      content: '# content',
      contentRef: null,
      manifest: {
        description: 'Description',
        displayName: 'Skill One',
        localizedDescriptions: {},
        localizedDisplayNames: {},
        permissions: {
          filesystem: 'none',
          network: { allowedHosts: [], enabled: false },
          tools: { allow: [] },
        },
        skillDependencies: [],
        toolDependencies: [],
      },
      resources: [],
      validation: { issues: [], validatedAt: new Date(0), validatorVersion: 'v1' },
    };
    mocks.dependentError = undefined;
    mocks.dependentData = { items: [], nextCursor: null };
    render(
      <MemoryRouter initialEntries={['/admin/skills/s1']}>
        <Routes>
          <Route element={<SkillDetailPage />} path="/admin/skills/:id" />
        </Routes>
      </MemoryRouter>,
    );

    for (const label of [
      'skillCatalog.version.create',
      'skillCatalog.actions.validate.label',
      'skillCatalog.actions.publish.label',
      'skillCatalog.actions.archive.label',
      'skillCatalog.actions.rollback.label',
    ]) {
      expect(screen.getByText(label)).toHaveProperty('disabled', true);
    }
    expect(screen.getByText('skillCatalog.actions.retry')).toBeTruthy();
  });

  it('keeps the failed-save retry button visible but disabled during refresh lock', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.SKILL_READ, PLATFORM_PERMISSIONS.SKILL_UPDATE];
    mocks.editor.mockReturnValue({
      actionError: 'skillCatalog.refresh.failed',
      baseDraft: {
        identity: {
          description: 'Old',
          displayName: 'Skill One',
          distribution: 'default',
          enabled: true,
        },
        versionDraft: null,
      },
      conflict: false,
      dirty: true,
      draft: {
        identity: {
          description: 'Local',
          displayName: 'Skill One',
          distribution: 'default',
          enabled: true,
        },
        versionDraft: null,
      },
      persistenceStatus: 'saved',
      rebaseConflicts: [],
      saveState: 'failed',
    });
    mocks.skillActions.mockReturnValue({
      actionLoading: null,
      canPublishSelected: false,
      openArchive: vi.fn(),
      openCreateVersion: vi.fn(),
      openPublish: vi.fn(),
      openRollback: vi.fn(),
      openSaveIdentity: vi.fn(),
      openValidate: vi.fn(),
      refreshFailed: true,
      retryRefresh: vi.fn(),
    });
    render(
      <MemoryRouter initialEntries={['/admin/skills/s1']}>
        <Routes>
          <Route element={<SkillDetailPage />} path="/admin/skills/:id" />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('skillCatalog.actions.save.retry')).toHaveProperty('disabled', true);
  });
});
