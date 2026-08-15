/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { UsageLog } from '@/types/usage/usageRecord';

import { GroupBy } from '../../types';
import UsageTrends from './UsageTrends';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@lobehub/ui', () => ({
  Skeleton: { Block: () => <div data-testid="usage-trends-skeleton" /> },
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Tabs: () => null,
}));

vi.mock('../components/StatsFormGroup', () => ({
  default: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
}));

vi.mock('../components/UsageBarChart', () => ({
  UsageBarChart: (props: {
    categories: string[];
    customCategories?: Record<string, string>;
    data: any[];
  }) => (
    <div
      data-categories={JSON.stringify(props.categories)}
      data-labels={JSON.stringify(props.customCategories)}
      data-rows={JSON.stringify(props.data)}
      data-testid="usage-bar-chart"
    />
  ),
}));

const record = (overrides: Partial<UsageLog['records'][number]>): UsageLog['records'][number] => ({
  createdAt: new Date('2026-05-27T00:00:00.000Z'),
  id: 'record',
  model: 'gpt-5-mini',
  provider: 'openai',
  spend: 1,
  totalInputTokens: 10,
  totalOutputTokens: 20,
  totalTokens: 30,
  type: 'chat',
  updatedAt: new Date('2026-05-27T00:00:00.000Z'),
  userId: 'user-1',
  ...overrides,
});

/**
 * `gpt-5-mini` (OpenAI) and `openai/gpt-5-mini` (Vercel AI Gateway) are two different models whose
 * model-bank cards both read "GPT-5 mini".
 */
const collidingLog: UsageLog[] = [
  {
    date: 1,
    day: '2026-05-27',
    records: [
      record({ id: 'record-1', model: 'gpt-5-mini', provider: 'openai', spend: 1 }),
      record({
        id: 'record-2',
        model: 'openai/gpt-5-mini',
        provider: 'vercelaigateway',
        spend: 2,
      }),
    ],
    totalRequests: 2,
    totalSpend: 3,
    totalTokens: 60,
  },
];

const readChart = () => {
  const chart = screen.getByTestId('usage-bar-chart');
  return {
    categories: JSON.parse(chart.dataset.categories!) as string[],
    labels: JSON.parse(chart.dataset.labels!) as Record<string, string>,
    rows: JSON.parse(chart.dataset.rows!) as Record<string, number | string>[],
  };
};

describe('UsageTrends', () => {
  it('keeps one series per raw model id when two ids share a display name', () => {
    render(<UsageTrends data={collidingLog} groupBy={GroupBy.Model} />);

    const { categories, rows } = readChart();

    expect(categories).toEqual(['gpt-5-mini', 'openai/gpt-5-mini']);
    // Merged series would have shown a single 3 instead of the two spends.
    expect(rows[0]['gpt-5-mini']).toBe(1);
    expect(rows[0]['openai/gpt-5-mini']).toBe(2);
  });

  it('disambiguates the colliding legend labels with the raw id', () => {
    render(<UsageTrends data={collidingLog} groupBy={GroupBy.Model} />);

    expect(readChart().labels).toEqual({
      'gpt-5-mini': 'GPT-5 mini (gpt-5-mini)',
      'openai/gpt-5-mini': 'GPT-5 mini (openai/gpt-5-mini)',
    });
  });

  it('labels a unique model with its display name alone', () => {
    render(
      <UsageTrends
        data={[{ ...collidingLog[0], records: [collidingLog[0].records[0]] }]}
        groupBy={GroupBy.Model}
      />,
    );

    const { categories, labels } = readChart();

    expect(categories).toEqual(['gpt-5-mini']);
    expect(labels).toEqual({ 'gpt-5-mini': 'GPT-5 mini' });
  });

  it('keys provider series by the provider id and labels them with the provider name', () => {
    render(<UsageTrends data={collidingLog} groupBy={GroupBy.Provider} />);

    const { categories, labels, rows } = readChart();

    expect(categories).toEqual(['openai', 'vercelaigateway']);
    expect(labels.openai).toBe('OpenAI');
    expect(rows[0].openai).toBe(1);
  });

  it('keys user series by the user id so two users sharing a name stay apart', () => {
    const userLog: UsageLog[] = [
      {
        ...collidingLog[0],
        records: [
          record({ id: 'record-1', spend: 1, userId: 'user-1' }),
          record({ id: 'record-2', spend: 2, userId: 'user-2' }),
        ],
      },
    ];

    render(
      <UsageTrends
        data={userLog}
        groupBy={GroupBy.User}
        resolveUser={() => ({ avatar: null, name: 'Ada' })}
      />,
    );

    const { categories, labels, rows } = readChart();

    expect(categories).toEqual(['user-1', 'user-2']);
    expect(labels).toEqual({ 'user-1': 'Ada (user-1)', 'user-2': 'Ada (user-2)' });
    expect(rows[0]['user-1']).toBe(1);
    expect(rows[0]['user-2']).toBe(2);
  });
});
