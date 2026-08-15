/**
 * @vitest-environment happy-dom
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { UsageLog } from '@/types/usage/usageRecord';

import { GroupBy } from '../../../../types';
import ModelTable from './ModelTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@lobehub/charts', () => ({
  CategoryBar: () => null,
  useThemeColorRange: () => ['#111111', '#222222'],
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: ({ model }: { model: string }) => <span data-testid="model-icon">{model}</span>,
  ProviderIcon: ({ provider }: { provider: string }) => (
    <span data-testid="provider-icon">{provider}</span>
  ),
}));

vi.mock('@lobehub/ui', () => ({
  Avatar: ({ title }: { title?: string }) => <span data-testid="user-avatar">{title}</span>,
  Collapse: ({ items }: { items: { children: ReactNode; key: string; label: ReactNode }[] }) => (
    <div>
      {items.map((item) => (
        <section key={item.key}>
          <div data-testid="outer-row">{item.label}</div>
          {item.children}
        </section>
      ))}
    </div>
  ),
  Flexbox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Skeleton: () => null,
  Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/components/InlineTable', () => ({
  default: ({
    columns,
    dataSource,
  }: {
    columns: { render: (value: unknown, record: any, index: number) => ReactNode }[];
    dataSource: { id: string }[];
  }) => (
    <div>
      {dataSource.map((record, index) => (
        <div data-testid="inner-row" key={record.id}>
          {columns[0].render(record.id, record, index)}
        </div>
      ))}
    </div>
  ),
}));

const usageLog: UsageLog[] = [
  {
    date: 1,
    day: '2026-05-27',
    records: [
      {
        createdAt: new Date('2026-05-27T00:00:00.000Z'),
        id: 'record-1',
        model: 'gpt-5-mini',
        provider: 'openai',
        spend: 1,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalTokens: 30,
        type: 'chat',
        updatedAt: new Date('2026-05-27T00:00:00.000Z'),
        userId: 'user-1',
      },
    ],
    totalRequests: 1,
    totalSpend: 1,
    totalTokens: 30,
  },
];

const innerRow = () => within(screen.getAllByTestId('inner-row')[0]);
const outerRow = () => within(screen.getAllByTestId('outer-row')[0]);

/**
 * Sub-rows always show the *other* dimension than the group they sit under, so the icon has to
 * follow the sub-row's own id — a provider glyph under a model group, a model glyph elsewhere.
 */
describe('ModelTable sub-row icons', () => {
  it('draws a provider icon on the sub-rows of a model group', () => {
    render(<ModelTable data={usageLog} groupBy={GroupBy.Model} />);

    expect(outerRow().getByTestId('model-icon')).toHaveTextContent('gpt-5-mini');
    expect(innerRow().getByTestId('provider-icon')).toHaveTextContent('openai');
    expect(innerRow().queryByTestId('model-icon')).toBeNull();
    expect(innerRow().getByText('OpenAI')).toBeInTheDocument();
  });

  it('draws a model icon on the sub-rows of a provider group', () => {
    render(<ModelTable data={usageLog} groupBy={GroupBy.Provider} />);

    expect(outerRow().getByTestId('provider-icon')).toHaveTextContent('openai');
    expect(innerRow().getByTestId('model-icon')).toHaveTextContent('gpt-5-mini');
    expect(innerRow().queryByTestId('provider-icon')).toBeNull();
    expect(innerRow().getByText('GPT-5 mini')).toBeInTheDocument();
  });

  it('draws a model icon on the sub-rows of a user group', () => {
    render(
      <ModelTable
        data={usageLog}
        groupBy={GroupBy.User}
        resolveUser={() => ({ avatar: null, name: 'Ada Lovelace' })}
      />,
    );

    expect(outerRow().getByTestId('user-avatar')).toHaveTextContent('Ada Lovelace');
    expect(innerRow().getByTestId('model-icon')).toHaveTextContent('gpt-5-mini');
    expect(innerRow().queryByTestId('provider-icon')).toBeNull();
  });
});
