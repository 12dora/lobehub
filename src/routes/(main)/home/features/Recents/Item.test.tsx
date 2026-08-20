/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { cssVar } from 'antd-style';
import { describe, expect, it, vi } from 'vitest';

import { type RecentItem } from '@/server/routers/lambda/recent';

import RecentListItem from './Item';

vi.mock('@lobehub/ui', () => ({
  ActionIcon: () => <span />,
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Flexbox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Icon: () => <span />,
}));

vi.mock('@/components/InlineRename', () => ({ default: () => null }));
vi.mock('@/features/AgentTasks/features/TaskStatusIcon', () => ({ default: () => <span /> }));
vi.mock('@/hooks/usePrefetchAgent', () => ({ usePrefetchAgent: () => vi.fn() }));
vi.mock('@/hooks/usePrefetchPage', () => ({ usePrefetchPage: () => vi.fn() }));
vi.mock('@/routes/(main)/agent/channel/const', () => ({ getPlatformIcon: () => null }));
vi.mock('./useDropdownMenu', () => ({
  useRecentItemDropdownMenu: () => ({ dropdownMenu: () => [], handleRename: vi.fn() }),
}));

vi.mock('@/features/NavPanel/components/NavItem', () => ({
  default: ({
    active,
    title,
    titleColor,
  }: {
    active?: boolean;
    title: string;
    titleColor?: string;
  }) => (
    <div data-active={String(!!active)} data-testid="nav-item" data-title-color={titleColor}>
      {title}
    </div>
  ),
}));

const topic: RecentItem = {
  agentId: 'agt_1',
  icon: 'topic',
  id: 'tpc_1',
  routePath: '/agent/agt_1/tpc_1',
  status: null,
  title: 'A topic',
  type: 'topic',
  updatedAt: new Date(0),
};

describe('RecentListItem', () => {
  it('forwards the selected state to NavItem (filled row, same as the agent topic list)', () => {
    render(<RecentListItem {...topic} active />);

    expect(screen.getByTestId('nav-item').dataset.active).toBe('true');
  });

  it('is not selected by default', () => {
    render(<RecentListItem {...topic} />);

    expect(screen.getByTestId('nav-item').dataset.active).toBe('false');
  });

  it('keeps titles fully emphasized even when inactive, like topic rows', () => {
    render(<RecentListItem {...topic} />);

    expect(screen.getByTestId('nav-item').dataset.titleColor).toBe(cssVar.colorText);
  });
});
