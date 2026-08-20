/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type RecentItem } from '@/server/routers/lambda/recent';

import RecentsList from './List';

const state = vi.hoisted(() => ({
  recents: [] as RecentItem[],
  search: '',
  slug: null as string | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a data-testid="recent-link" href={to}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: state.slug ? `/${state.slug}` : '/' }),
  useSearchParams: () => [new URLSearchParams(state.search), vi.fn()],
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  useActiveWorkspaceSlug: () => state.slug,
}));

vi.mock('@/components/AsyncBoundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/features/NavPanel/components/SkeletonList', () => ({
  default: () => <div data-testid="skeleton" />,
}));

vi.mock('@/features/NavPanel/components/NavItem', () => ({
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('./AllRecentsDrawer', () => ({ default: () => null }));

vi.mock('./Item', () => ({
  default: ({ active, title }: { active?: boolean; title: string }) => (
    <div data-active={String(!!active)} data-testid="recent-item">
      {title}
    </div>
  ),
}));

vi.mock('@/store/home', () => ({
  useHomeStore: (selector: (s: unknown) => unknown) =>
    selector({
      allRecentsDrawerOpen: false,
      closeAllRecentsDrawer: vi.fn(),
      openAllRecentsDrawer: vi.fn(),
      recents: state.recents,
    }),
}));

vi.mock('@/store/home/selectors', () => ({
  homeRecentSelectors: {
    isRecentsInit: () => true,
    recents: (s: { recents: RecentItem[] }) => s.recents,
  },
}));

vi.mock('@/store/global', () => ({
  useGlobalStore: (selector: (s: unknown) => unknown) => selector({}),
}));

vi.mock('@/store/global/selectors', () => ({
  systemStatusSelectors: { recentPageSize: () => 10 },
}));

const item = (partial: Partial<RecentItem> & Pick<RecentItem, 'type'>): RecentItem => ({
  agentId: null,
  icon: partial.type,
  id: 'id_1',
  routePath: '/',
  status: null,
  title: 'title',
  updatedAt: new Date(0),
  ...partial,
});

const hrefs = () => screen.getAllByTestId('recent-link').map((el) => el.getAttribute('href') ?? '');

describe('RecentsList', () => {
  beforeEach(() => {
    state.recents = [];
    state.search = '';
    state.slug = null;
  });

  it('links topics to the home-context URL so the left nav does not swap', () => {
    state.recents = [
      item({ agentId: 'agt_1', id: 'tpc_1', routePath: '/agent/agt_1/tpc_1', type: 'topic' }),
      item({ id: 'tpc_2', routePath: '/group/grp_1/tpc_2', type: 'topic' }),
    ];

    render(<RecentsList />);

    expect(hrefs()).toEqual(['/?agent=agt_1&topic=tpc_1', '/?group=grp_1&topic=tpc_2']);
  });

  it('prefixes the home-context URL with the active workspace slug', () => {
    state.slug = 'acme';
    state.recents = [
      item({ agentId: 'agt_1', id: 'tpc_1', routePath: '/agent/agt_1/tpc_1', type: 'topic' }),
    ];

    render(<RecentsList />);

    expect(hrefs()).toEqual(['/acme/?agent=agt_1&topic=tpc_1']);
  });

  it('keeps documents and tasks on their own routes', () => {
    state.recents = [
      item({ id: 'doc_1', routePath: '/page/doc_1', type: 'document' }),
      item({ agentId: 'agt_1', id: 'tsk_1', routePath: '/agent/agt_1/task/tsk_1', type: 'task' }),
    ];

    render(<RecentsList />);

    expect(hrefs()).toEqual(['/page/doc_1', '/agent/agt_1/task/tsk_1']);
  });

  it('highlights the topic that is open in the right column', () => {
    state.search = 'agent=agt_1&topic=tpc_2';
    state.recents = [
      item({
        agentId: 'agt_1',
        id: 'tpc_1',
        routePath: '/agent/agt_1/tpc_1',
        type: 'topic',
        title: 'one',
      }),
      item({
        agentId: 'agt_1',
        id: 'tpc_2',
        routePath: '/agent/agt_1/tpc_2',
        type: 'topic',
        title: 'two',
      }),
    ];

    render(<RecentsList />);

    const rows = screen.getAllByTestId('recent-item');
    expect(rows.map((el) => el.dataset.active)).toEqual(['false', 'true']);
  });

  it('does not highlight anything without a home conversation', () => {
    state.recents = [
      item({ agentId: 'agt_1', id: 'tpc_1', routePath: '/agent/agt_1/tpc_1', type: 'topic' }),
    ];

    render(<RecentsList />);

    expect(screen.getByTestId('recent-item').dataset.active).toBe('false');
  });
});
