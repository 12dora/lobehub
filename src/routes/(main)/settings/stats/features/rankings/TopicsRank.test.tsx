// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_GLOBAL_STATS_SCOPE,
  personalStatsDataSource,
  type StatsDataSource,
  StatsDataSourceProvider,
  StatsFilterProvider,
} from '@/features/SettingsStats';

import TopicsRank from './TopicsRank';

const mocks = vi.hoisted(() => ({
  currentUserId: 'admin-1' as string | undefined,
  error: undefined as unknown,
  inboxAgentId: 'inbox-agent' as string | undefined,
  navigate: vi.fn(),
  permissions: [] as string[],
  rankTopics: vi.fn(),
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock('antd-style', () => ({ createStaticStyles: () => ({}), cssVar: {} }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/charts', () => ({
  BarList: ({
    data,
    onValueChange,
  }: {
    data?: Array<{ key?: string; name: ReactNode }>;
    onValueChange?: (item: unknown) => void;
  }) => (
    <div data-testid="bar-list">
      {(data ?? []).map((item, index) => (
        <button key={item.key ?? index} type="button" onClick={() => onValueChange?.(item)}>
          {item.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@lobehub/ui', () => ({
  ActionIcon: () => null,
  Alert: ({ action, message }: { action?: ReactNode; message?: ReactNode }) => (
    <div role="alert">
      {message}
      {action}
    </div>
  ),
  Icon: () => null,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('@/components/AsyncBoundary', () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ImperativeModal', () => ({
  default: () => null,
}));

vi.mock('../components/StatsFormGroup', () => ({
  default: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));

vi.mock('@/libs/router/Link', () => ({
  default: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a data-testid="topic-link" href={href}>
      {children}
    </a>
  ),
}));

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => mocks.navigate,
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock('@/store/agent/selectors', () => ({
  builtinAgentSelectors: { inboxAgentId: () => mocks.inboxAgentId },
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock('@/store/user/selectors', () => ({
  userProfileSelectors: { userId: () => mocks.currentUserId },
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useOptionalAdminAccess: () => ({ permissions: mocks.permissions }),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (_key: unknown, fetcher: () => Promise<unknown>) => {
    void fetcher;
    return {
      data: mocks.error ? undefined : mocks.rows,
      error: mocks.error,
      isLoading: false,
      mutate: vi.fn(),
    };
  },
}));

const RANGE = {
  endAt: '2026-07-22T15:30:00.000Z',
  startAt: '2026-07-16T00:00:00.000Z',
};

const adminSource: StatsDataSource = {
  ...personalStatsDataSource,
  rankTopics: mocks.rankTopics,
  scopeKey: ADMIN_GLOBAL_STATS_SCOPE,
};

const renderWith = (source: StatsDataSource) =>
  render(
    <StatsDataSourceProvider value={source}>
      <StatsFilterProvider value={RANGE}>
        <TopicsRank />
      </StatsFilterProvider>
    </StatsDataSourceProvider>,
  );

const bars = () => [...screen.getByTestId('bar-list').querySelectorAll('button')];

describe('TopicsRank', () => {
  beforeEach(() => {
    mocks.currentUserId = 'admin-1';
    mocks.error = undefined;
    mocks.inboxAgentId = 'inbox-agent';
    mocks.navigate.mockReset();
    mocks.permissions = [];
    mocks.rankTopics
      .mockReset()
      .mockResolvedValue({ contentAccessMode: 'metadata_only', items: [] });
    mocks.rows = [];
  });

  it('opensTheOwnersChatInPersonalStats', () => {
    mocks.rows = [{ agentId: 'agent-9', count: 3, id: 'topic-9', title: 'My topic' }];

    renderWith(personalStatsDataSource);

    expect(screen.getByTestId('topic-link').getAttribute('href')).toBe('/agent/agent-9/topic-9');
    fireEvent.click(bars()[0]!);
    expect(mocks.navigate).toHaveBeenCalledWith('/agent/agent-9/topic-9');
  });

  it('keepsTheInboxFallbackForTheSignedInUsersOwnLegacyTopics', () => {
    mocks.rows = [{ agentId: null, count: 2, id: 'topic-legacy', title: 'Legacy topic' }];

    renderWith(personalStatsDataSource);

    // Personal scope ranks the caller's own topics, so the inbox fallback still lands in
    // their own chat — the behaviour admin scope must not inherit.
    expect(screen.getByTestId('topic-link').getAttribute('href')).toBe(
      '/agent/inbox-agent/topic-legacy',
    );
  });

  it('sendsAnotherUsersTopicToAuditEvidenceInsteadOfTheAdminsOwnChat', () => {
    mocks.rows = [
      { agentId: 'agent-7', count: 5, id: 'topic-7', title: 'Their topic', userId: 'user-7' },
    ];

    renderWith(adminSource);

    const href = screen.getByTestId('topic-link').getAttribute('href');
    expect(href).toBe('/admin/audit/conversations/user-7/topics/topic-7');

    fireEvent.click(bars()[0]!);
    // `escape` keeps the workspace slug out: admin routes live outside workspaces.
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/admin/audit/conversations/user-7/topics/topic-7',
      {
        escape: true,
      },
    );
    expect(mocks.navigate.mock.calls.flat().join(' ')).not.toContain('/agent/');
  });

  it('neverFallsBackToTheAdminsInboxForAnOwnerlessTopic', () => {
    mocks.rows = [{ agentId: null, count: 4, id: 'topic-orphan', title: 'Ownerless topic' }];

    renderWith(adminSource);

    // No owner and no agent: the bar stays informational rather than grafting a stranger's
    // topic onto the admin's own inbox agent.
    expect(screen.queryByTestId('topic-link')).toBeNull();
    fireEvent.click(bars()[0]!);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('stillOpensTheAdminsOwnTopicsInTheirChat', () => {
    mocks.rows = [
      { agentId: 'agent-1', count: 6, id: 'topic-mine', title: 'Mine', userId: 'admin-1' },
    ];

    renderWith(adminSource);

    expect(screen.getByTestId('topic-link').getAttribute('href')).toBe('/agent/agent-1/topic-mine');
    fireEvent.click(bars()[0]!);
    expect(mocks.navigate).toHaveBeenCalledWith('/agent/agent-1/topic-mine');
  });

  it('showsThePolicyBannerAndNoTitlesWhenContentAccessIsRefused', () => {
    mocks.error = { data: { code: 'FORBIDDEN' } };
    mocks.rows = [
      { agentId: 'agent-7', count: 5, id: 'topic-7', title: 'Leaked title', userId: 'user-7' },
    ];
    mocks.permissions = ['platform_audit:retention_operate:all'];

    renderWith(adminSource);

    expect(screen.getByRole('alert').textContent).toContain(
      'stats.topicsRank.contentAccessDisabled',
    );
    expect(screen.queryByText('Leaked title')).toBeNull();
    expect(bars()).toHaveLength(0);

    fireEvent.click(screen.getByText('stats.topicsRank.contentAccessDisabledAction'));
    expect(mocks.navigate).toHaveBeenCalledWith('/admin/audit/retention', { escape: true });
  });

  it('hidesTheSettingsShortcutFromAdminsWhoCannotOpenThePolicy', () => {
    mocks.error = { data: { code: 'FORBIDDEN' } };

    renderWith(adminSource);

    expect(screen.queryByText('stats.topicsRank.contentAccessDisabledAction')).toBeNull();
  });

  it('keepsPersonalScopeErrorsOnTheOrdinaryErrorPath', () => {
    mocks.error = { data: { code: 'FORBIDDEN' } };

    renderWith(personalStatsDataSource);

    expect(screen.queryByRole('alert')).toBeNull();
  });
});
