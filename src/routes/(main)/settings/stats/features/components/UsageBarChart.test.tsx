/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { UsageBarChart } from './UsageBarChart';

vi.mock('@lobehub/charts', () => ({
  BarChart: ({
    customCategories,
    customTooltip: Tooltip,
  }: {
    customCategories?: Record<string, string>;
    customTooltip: ComponentType<any>;
  }) => (
    <Tooltip
      active
      customCategories={customCategories}
      label="2026-05-27"
      payload={[{ color: '#111111', name: 'gpt-5-mini', value: 1 }]}
      valueFormatter={(value: number) => String(value)}
    />
  ),
  ChartTooltipFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ChartTooltipRow: ({ name, value }: { name: string; value: string }) => (
    <div data-testid="tooltip-row">{`${name}=${value}`}</div>
  ),
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('antd', () => ({
  Divider: () => null,
}));

describe('UsageBarChart tooltip', () => {
  it('names each row with the label the chart carries for that series key', () => {
    render(
      <UsageBarChart
        categories={['gpt-5-mini']}
        customCategories={{ 'gpt-5-mini': 'GPT-5 mini (gpt-5-mini)' }}
        data={[{ 'day': '2026-05-27', 'gpt-5-mini': 1 }]}
        index="day"
        showType="spend"
      />,
    );

    expect(screen.getByTestId('tooltip-row')).toHaveTextContent('GPT-5 mini (gpt-5-mini)=1.00');
  });

  it('falls back to the raw series key when no label was provided', () => {
    render(
      <UsageBarChart
        categories={['gpt-5-mini']}
        data={[{ 'day': '2026-05-27', 'gpt-5-mini': 1 }]}
        index="day"
        showType="spend"
      />,
    );

    expect(screen.getByTestId('tooltip-row')).toHaveTextContent('gpt-5-mini=1.00');
  });
});
