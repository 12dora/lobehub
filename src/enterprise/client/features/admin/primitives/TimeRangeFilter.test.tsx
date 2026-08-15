// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import dayjs from 'dayjs';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { AdminTimeRangeKey } from './timeRange.utils';
import TimeRangeFilter, { useAdminTimeRange } from './TimeRangeFilter';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Select: ({
    onChange,
    options,
    value,
  }: {
    onChange?: (value: string) => void;
    options?: Array<{ label: string; value: string }>;
    value?: string;
  }) => (
    <select data-testid="preset" value={value} onChange={(event) => onChange?.(event.target.value)}>
      {(options ?? []).map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('antd', () => ({
  DatePicker: {
    RangePicker: ({ value }: { value?: Array<{ format: (f: string) => string } | null> }) => (
      <div
        data-from={value?.[0]?.format('YYYY-MM-DD') ?? ''}
        data-testid="range-picker"
        data-to={value?.[1]?.format('YYYY-MM-DD') ?? ''}
      />
    ),
  },
}));

const Harness = () => {
  const { customFrom, customTo, range, rangeKey, setCustomRange, setRangeKey } =
    useAdminTimeRange();
  const location = useLocation();

  return (
    <div>
      <span data-testid="search">{location.search}</span>
      <span data-testid="key">{rangeKey}</span>
      <span data-testid="label">{range.label}</span>
      <span data-testid="start">{range.startAt}</span>
      <span data-testid="end">{range.endAt}</span>
      <TimeRangeFilter
        customFrom={customFrom}
        customTo={customTo}
        rangeKey={rangeKey}
        setCustomRange={setCustomRange}
        setRangeKey={setRangeKey}
      />
      <button type="button" onClick={() => setCustomRange(undefined, undefined)}>
        clear-days
      </button>
    </div>
  );
};

const renderAt = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/admin${search}`]}>
      <Harness />
    </MemoryRouter>,
  );

const search = () => screen.getByTestId('search').textContent;
const key = () => screen.getByTestId('key').textContent;

describe('useAdminTimeRange URL state', () => {
  it('keepsAUsableCustomWindowExactlyAsBookmarked', () => {
    renderAt('?range=custom&from=2026-07-01&to=2026-07-03');

    expect(key()).toBe('custom');
    expect(search()).toBe('?range=custom&from=2026-07-01&to=2026-07-03');
    expect(screen.getByTestId('range-picker').dataset.from).toBe('2026-07-01');
    expect(screen.getByTestId('range-picker').dataset.to).toBe('2026-07-03');
    // Half-open: the whole of 07-03 is inside the window.
    expect(dayjs(screen.getByTestId('end').textContent).format('YYYY-MM-DD')).toBe('2026-07-04');
  });

  it.each([
    ['impossible days', '?range=custom&from=2026-02-31&to=2026-03-05'],
    ['a missing upper bound', '?range=custom&from=2026-07-01'],
    ['a missing lower bound', '?range=custom&to=2026-07-01'],
    ['no days at all', '?range=custom'],
    ['an inverted window', '?range=custom&from=2026-07-05&to=2026-07-01'],
    ['a blank day', '?range=custom&from=&to='],
  ])('canonicalizes %s away instead of showing 自定义 over the default window', (_label, url) => {
    renderAt(url);

    // The control tells the truth about what was queried…
    expect(key()).toBe('30d');
    expect(screen.getByTestId('label').textContent).toBe('timeRange.preset.30d');
    expect(screen.queryByTestId('range-picker')).toBeNull();
    // …and so does the URL, so a reload / share does not resurrect the dead state.
    expect(search()).toBe('');
  });

  it('dropsAnUnknownPreset', () => {
    renderAt('?range=all-time&from=2026-07-01&to=2026-07-03');
    expect(key()).toBe('30d');
    expect(search()).toBe('');
  });

  it('dropsTheRedundantDefaultPreset', () => {
    renderAt('?range=30d');
    expect(key()).toBe('30d');
    expect(search()).toBe('');
  });

  it('seedsThePickerWithTheWindowOnScreenWhenSwitchingToCustom', () => {
    renderAt('?range=7d');
    const start = screen.getByTestId('start').textContent!;

    fireEvent.change(screen.getByTestId('preset'), { target: { value: 'custom' } });

    expect(key()).toBe('custom');
    const picker = screen.getByTestId('range-picker');
    expect(picker.dataset.from).toBe(dayjs(start).format('YYYY-MM-DD'));
    expect(picker.dataset.to).toBe(dayjs().format('YYYY-MM-DD'));
    expect(search()).toContain('range=custom');
    expect(search()).toContain(`from=${dayjs(start).format('YYYY-MM-DD')}`);
  });

  it('fallsBackToTheDefaultPresetWhenTheCustomPickerIsCleared', () => {
    renderAt('?range=custom&from=2026-07-01&to=2026-07-03');
    expect(key()).toBe('custom');

    fireEvent.click(screen.getByRole('button', { name: 'clear-days' }));

    expect(key()).toBe('30d');
    expect(search()).toBe('');
  });

  it('switchingBackToAPresetLeavesNoStaleCustomDaysBehind', () => {
    renderAt('?range=custom&from=2026-07-01&to=2026-07-03');

    fireEvent.change(screen.getByTestId('preset'), {
      target: { value: 'today' satisfies AdminTimeRangeKey },
    });

    expect(key()).toBe('today');
    expect(search()).toBe('?range=today');
  });
});
