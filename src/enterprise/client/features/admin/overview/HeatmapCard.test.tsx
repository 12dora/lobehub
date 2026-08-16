// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useStatsDataSource, useStatsFilter } from '@/features/SettingsStats';

import HeatmapCard from './HeatmapCard';

vi.mock('@/enterprise/client/features/admin/stats/adminStatsDataSource', () => ({
  adminGlobalStatsDataSource: { activitySeries: vi.fn(), scopeKey: 'admin-global' },
}));

vi.mock('@/routes/(main)/settings/stats/features/visualization', () => ({
  AiHeatmaps: () => {
    const filter = useStatsFilter();
    const { scopeKey } = useStatsDataSource();
    return (
      <div
        data-endat={filter.endAt ?? ''}
        data-label={filter.rangeLabel ?? ''}
        data-scope={scopeKey}
        data-startat={filter.startAt ?? ''}
        data-testid="activity"
      />
    );
  },
}));

const RANGE = {
  endAt: '2026-08-16T09:30:00.000Z',
  key: '30d' as const,
  label: 'Last 30 days',
  startAt: '2026-07-18T00:00:00.000Z',
};

describe('AdminOverviewHeatmapCard', () => {
  it('hands the page window to the activity card so it stops answering for a fixed year', () => {
    render(<HeatmapCard range={RANGE} />);

    const card = screen.getByTestId('activity');
    expect(card.dataset.startat).toBe(RANGE.startAt);
    expect(card.dataset.endat).toBe(RANGE.endAt);
    expect(card.dataset.label).toBe(RANGE.label);
    expect(card.dataset.scope).toBe('admin-global');
  });

  it('renders without a range before the filter resolves', () => {
    render(<HeatmapCard />);

    const card = screen.getByTestId('activity');
    expect(card.dataset.startat).toBe('');
    expect(card.dataset.endat).toBe('');
  });
});
