// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ContentModerationOverview,
  ContentModerationStatsOutput,
} from '@/types/platform/contentModeration';

import OverviewTab from './OverviewTab';

const mocks = vi.hoisted(() => ({
  overview: {
    data: undefined as ContentModerationOverview | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
  },
  stats: {
    data: undefined as ContentModerationStatsOutput | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
  },
  statsInput: undefined as { from: Date; timezone: string; to: Date } | undefined,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('@lobehub/ui', () => ({
  Alert: ({ action, message }: { action?: ReactNode; message?: ReactNode }) => (
    <div data-testid="alert">
      <span>{message}</span>
      {action}
    </div>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Skeleton: { Block: () => <div data-testid="skeleton" /> },
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('../../primitives/TimeRangeFilter', () => ({
  default: () => <div data-testid="time-range" />,
}));
vi.mock('../../primitives/DangerConfirm', () => ({ openDangerConfirm: vi.fn() }));
vi.mock('../../primitives/runAdminMutation', () => ({ runAdminMutation: vi.fn() }));
vi.mock('./StatusCards', () => ({
  default: ({ data }: { data: ContentModerationOverview }) => (
    <div data-testid="status-cards">{data.mode}</div>
  ),
}));
vi.mock('./KpiRow', () => ({
  default: ({ loading, mode }: { loading: boolean; mode?: string }) => (
    <div data-loading={String(loading)} data-mode={mode ?? ''} data-testid="kpi-row" />
  ),
}));
vi.mock('./ModerationCharts', () => ({
  default: ({ error, loading }: { error: boolean; loading: boolean }) => (
    <div data-error={String(error)} data-loading={String(loading)} data-testid="charts" />
  ),
}));
vi.mock('../hooks', () => ({
  invalidateModerationOverview: vi.fn(),
  invalidateModerationRecords: vi.fn(),
  useModerationOverview: () => mocks.overview,
  useModerationStats: (_enabled: boolean, input: { from: Date; timezone: string; to: Date }) => {
    mocks.statsInput = input;
    return mocks.stats;
  },
}));
vi.mock('../service', () => ({
  adminContentModerationService: { clearDecisionCache: vi.fn() },
}));
vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'better-auth', permissions: [], status: 'allowed' }),
}));

const overview = (patch: Partial<ContentModerationOverview> = {}): ContentModerationOverview =>
  ({
    autoBan: { enabled: false, threshold: 10, windowDays: 30 },
    classifier: { health: null, kind: 'none' },
    decisionCacheCount: 0,
    downgrade: null,
    keywordRuleCount: 0,
    mode: 'off',
    updatedAt: null,
    warnings: [],
    ...patch,
  }) as ContentModerationOverview;

const renderTab = () =>
  render(<OverviewTab canManage enabled onOpenRecordsForUser={vi.fn()} onOpenSettings={vi.fn()} />);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.overview.data = overview();
  mocks.overview.error = undefined;
  mocks.overview.isLoading = false;
  mocks.stats.data = undefined;
  mocks.stats.error = undefined;
  mocks.stats.isLoading = false;
});

describe('OverviewTab', () => {
  it('queries a 7-day window with the browser time zone', () => {
    renderTab();
    const input = mocks.statsInput!;
    expect(input.timezone).toBeTruthy();
    const days = (input.to.getTime() - input.from.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThan(8);
  });

  it('renders one alert per server warning', () => {
    mocks.overview.data = overview({
      warnings: ['client_fetch_bypass', 'downgrade_not_configured'],
    });
    renderTab();
    expect(screen.getAllByTestId('alert')).toHaveLength(2);
    expect(screen.getByText('contentModeration.warning.client_fetch_bypass.title')).toBeTruthy();
  });

  it('shows a skeleton while the status is loading and a retry when it fails', () => {
    mocks.overview.data = undefined;
    mocks.overview.isLoading = true;
    const { rerender } = renderTab();
    expect(screen.getByTestId('skeleton')).toBeTruthy();
    expect(screen.queryByTestId('status-cards')).toBeNull();

    mocks.overview.isLoading = false;
    mocks.overview.error = new Error('boom');
    rerender(
      <OverviewTab canManage enabled onOpenRecordsForUser={vi.fn()} onOpenSettings={vi.fn()} />,
    );
    expect(screen.getByText('contentModeration.overview.loadFailed')).toBeTruthy();
  });

  it('adds the 拟处置 tiles only while the mode is observe', () => {
    renderTab();
    expect(screen.getByTestId('kpi-row').dataset.mode).toBe('off');

    mocks.overview.data = overview({ mode: 'observe' });
    const { rerender } = renderTab();
    rerender(
      <OverviewTab canManage enabled onOpenRecordsForUser={vi.fn()} onOpenSettings={vi.fn()} />,
    );
    expect(screen.getAllByTestId('kpi-row')[1].dataset.mode).toBe('observe');
  });

  it('propagates a stats failure to the charts instead of drawing empty axes', () => {
    mocks.stats.error = new Error('boom');
    renderTab();
    expect(screen.getByTestId('charts').dataset.error).toBe('true');
  });
});
