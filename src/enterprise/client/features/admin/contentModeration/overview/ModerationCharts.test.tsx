// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentModerationStatsOutput } from '@/types/platform/contentModeration';

import ModerationCharts from './ModerationCharts';

const mocks = vi.hoisted(() => ({
  barLists: [] as {
    data: { key?: string; name: ReactNode; value: number }[];
    onValueChange?: (bar: unknown) => void;
  }[],
  areaCharts: [] as { categories: string[]; data: Record<string, unknown>[] }[],
  barCharts: [] as { data: Record<string, unknown>[] }[],
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('@lobehub/charts', () => ({
  AreaChart: (props: { categories: string[]; data: Record<string, unknown>[] }) => {
    mocks.areaCharts.push(props);
    return <div data-testid="area-chart" />;
  },
  BarChart: (props: { data: Record<string, unknown>[] }) => {
    mocks.barCharts.push(props);
    return <div data-testid="bar-chart" />;
  },
  BarList: (props: {
    data: { key?: string; name: ReactNode; value: number }[];
    onValueChange?: (bar: unknown) => void;
  }) => {
    mocks.barLists.push(props);
    return (
      <div data-testid="bar-list">
        {props.data.map((bar, index) => (
          <button key={index} type="button" onClick={() => props.onValueChange?.(bar)}>
            {String(bar.name)}
          </button>
        ))}
      </div>
    );
  },
}));
vi.mock('./ChartCard', () => ({
  default: ({
    children,
    empty,
    error,
    loading,
    title,
  }: {
    children?: ReactNode;
    empty: boolean;
    error: boolean;
    loading: boolean;
    title: string;
  }) => (
    <section data-empty={String(empty)} data-testid={`card-${title}`}>
      {loading || error || empty ? null : children}
    </section>
  ),
}));

const stats = (patch: Partial<ContentModerationStatsOutput> = {}): ContentModerationStatsOutput =>
  ({
    categories: [{ category: 'sexual', count: 4 }],
    kpi: {
      allow: 10,
      avgLatencyMs: 120,
      block: 2,
      downgrade: 1,
      error: 0,
      log: 3,
      total: 16,
      wouldBlock: 0,
      wouldDowngrade: 0,
    },
    requestKinds: [{ count: 16, kind: 'chat' }],
    series: [
      {
        allow: 5,
        block: 1,
        bucketStart: '2026-08-17T00:00:00.000Z',
        downgrade: 0,
        error: 0,
        log: 2,
      },
    ],
    sources: [{ count: 6, source: 'keyword' }],
    topUsers: [{ count: 4, email: 'alice@example.com', userId: 'user-1' }],
    ...patch,
  }) as ContentModerationStatsOutput;

beforeEach(() => {
  mocks.areaCharts.length = 0;
  mocks.barCharts.length = 0;
  mocks.barLists.length = 0;
});

describe('ModerationCharts', () => {
  it('stacks the five outcomes in the trend series', () => {
    render(
      <ModerationCharts
        data={stats()}
        error={false}
        loading={false}
        onRetry={vi.fn()}
        onSelectUser={vi.fn()}
      />,
    );
    const chart = mocks.areaCharts[0];
    expect(chart.categories).toEqual([
      'contentModeration.action.allow',
      'contentModeration.action.log',
      'contentModeration.action.downgrade',
      'contentModeration.action.block',
      'contentModeration.action.error',
    ]);
    expect(chart.data[0]['contentModeration.action.allow']).toBe(5);
    expect(chart.data[0]['contentModeration.action.block']).toBe(1);
  });

  it('drills into the record list when a top offender is clicked', () => {
    const onSelectUser = vi.fn();
    render(
      <ModerationCharts
        data={stats()}
        error={false}
        loading={false}
        onRetry={vi.fn()}
        onSelectUser={onSelectUser}
      />,
    );
    fireEvent.click(screen.getByText('alice@example.com'));
    expect(onSelectUser).toHaveBeenCalledWith('user-1');
  });

  it('treats an all-zero window as empty rather than drawing a flat chart', () => {
    render(
      <ModerationCharts
        error={false}
        loading={false}
        data={stats({
          categories: [],
          series: [
            {
              allow: 0,
              block: 0,
              bucketStart: '2026-08-17T00:00:00.000Z',
              downgrade: 0,
              error: 0,
              log: 0,
            },
          ],
          sources: [],
          topUsers: [],
        })}
        onRetry={vi.fn()}
        onSelectUser={vi.fn()}
      />,
    );
    expect(screen.getByTestId('card-contentModeration.charts.trend').dataset.empty).toBe('true');
    expect(screen.getByTestId('card-contentModeration.charts.topUsers').dataset.empty).toBe('true');
  });

  it('reports empty while there is no payload at all', () => {
    render(
      <ModerationCharts error={false} loading={false} onRetry={vi.fn()} onSelectUser={vi.fn()} />,
    );
    expect(screen.getByTestId('card-contentModeration.charts.categories').dataset.empty).toBe(
      'true',
    );
    expect(mocks.areaCharts).toHaveLength(0);
  });
});
