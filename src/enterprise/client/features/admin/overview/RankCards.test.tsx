// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RankCards from './RankCards';

const mocks = vi.hoisted(() => ({
  agents: {
    data: undefined as
      Array<{ avatar?: string; count: number; id: string; title?: string }> | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
  },
  models: {
    data: undefined as Array<{ count: number; id: string }> | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
  },
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/charts', () => ({
  BarList: ({ data }: { data?: Array<{ id: string; name: string }> }) => (
    <div data-testid="bar-list">
      {(data ?? []).map((item) => (
        <span key={item.id}>{item.name}</span>
      ))}
    </div>
  ),
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: () => null,
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({
    action,
    message,
    type,
  }: {
    action?: ReactNode;
    message?: ReactNode;
    type?: string;
  }) => (
    <div data-testid={`alert-${type}`}>
      <span>{message}</span>
      {action}
    </div>
  ),
  Avatar: () => null,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('./useOverviewStats', () => ({
  useOverviewAgentRank: () => mocks.agents,
  useOverviewModelRank: () => mocks.models,
}));

describe('AdminOverviewRankCards', () => {
  beforeEach(() => {
    mocks.models.data = undefined;
    mocks.models.error = undefined;
    mocks.models.isLoading = false;
    mocks.models.mutate.mockReset();
    mocks.agents.data = undefined;
    mocks.agents.error = undefined;
    mocks.agents.isLoading = false;
    mocks.agents.mutate.mockReset();
  });

  it('rendersRetryableErrorOnInitialFailure', () => {
    mocks.models.error = new Error('denied');
    mocks.agents.error = new Error('denied');
    render(<RankCards />);
    expect(screen.getAllByTestId('alert-error')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'overview.error.retry' })[0]!);
    expect(mocks.models.mutate).toHaveBeenCalled();
  });

  it('preservesEmptyStateWithRefreshWarningOnStaleEmptyRefreshFailure', () => {
    mocks.models.data = [];
    mocks.models.error = new Error('refresh failed');
    mocks.agents.data = [{ count: 0, id: 'a', title: 'Agent' }];
    mocks.agents.error = new Error('refresh failed');
    render(<RankCards />);
    expect(screen.getAllByTestId('alert-warning')).toHaveLength(2);
    expect(screen.getAllByText('overview.rank.emptyTitle')).toHaveLength(2);
    expect(screen.queryByTestId('bar-list')).toBeNull();
  });

  it('labelsModelsWithTheirCardNameAndKeepsUnknownIdsVerbatim', () => {
    mocks.models.data = [
      { count: 5, id: 'gpt-5.6-luna' },
      { count: 1, id: 'some-self-hosted-model' },
    ];
    mocks.agents.data = [];
    render(<RankCards />);
    expect(screen.getByText('GPT-5.6 Luna')).toBeInTheDocument();
    expect(screen.getByText('some-self-hosted-model')).toBeInTheDocument();
  });

  it('keepsStaleRankDataWithRefreshWarning', () => {
    mocks.models.data = [{ count: 3, id: 'gpt' }];
    mocks.models.error = new Error('refresh failed');
    mocks.agents.data = [{ count: 2, id: 'a', title: 'Agent' }];
    mocks.agents.error = undefined;
    render(<RankCards />);
    expect(screen.getByTestId('alert-warning')).toHaveTextContent('overview.error.refreshFailed');
    expect(screen.getAllByTestId('bar-list')).toHaveLength(2);
  });
});
