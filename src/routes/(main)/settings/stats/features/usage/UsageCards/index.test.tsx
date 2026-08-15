// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatsFilterProvider } from '@/features/SettingsStats';

import { GroupBy } from '../../../types';
import UsageCards from './index';

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('./ActiveModels', () => ({ default: () => <div data-testid="models" /> }));
vi.mock('./MonthSpend', () => ({ default: () => <div data-testid="month" /> }));
vi.mock('./TodaySpend', () => ({ default: () => <div data-testid="today" /> }));

/** Clock frozen at load, then nudged forward like a real session would be. */
const LOAD = new Date('2026-07-22T09:30:00.000Z');

const renderCards = (endAt?: string) =>
  render(
    <StatsFilterProvider value={endAt ? { endAt, startAt: '2026-06-22T00:00:00.000Z' } : {}}>
      <UsageCards data={[]} groupBy={GroupBy.Model} isLoading={false} />
    </StatsFilterProvider>,
  );

describe('UsageCards today card', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(LOAD);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keepsTheTodayCardForAPresetWindowEvenAfterTheClockPassesItsFrozenEnd', () => {
    // Presets end at "now" as of selection; a millisecond later the live clock is past it.
    const endAt = new Date(LOAD).toISOString();
    vi.advanceTimersByTime(5 * 60 * 1000);

    renderCards(endAt);
    expect(screen.getByTestId('today')).toBeTruthy();
  });

  it('keepsTheTodayCardForACustomWindowWhoseLastIncludedDayIsToday', () => {
    // Custom ranges are end-exclusive: "…through today" ends at tomorrow 00:00.
    renderCards(dayjs().startOf('day').add(1, 'day').toISOString());
    expect(screen.getByTestId('today')).toBeTruthy();
  });

  it('dropsTheTodayCardForAWindowThatEndedBeforeToday', () => {
    // Ends at today 00:00 → the last included day is yesterday, so "today" is a $0 lie.
    renderCards(dayjs().startOf('day').toISOString());
    expect(screen.queryByTestId('today')).toBeNull();
    expect(screen.getByTestId('month')).toBeTruthy();
  });

  it('keepsTheTodayCardWhenNoWindowIsActive', () => {
    renderCards();
    expect(screen.getByTestId('today')).toBeTruthy();
  });
});
