// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import ActivityHourGrid from './ActivityHourGrid';

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children, style }: { children?: ReactNode; style?: Record<string, string> }) => (
    <div data-testid={'grid-root'} style={style}>
      {children}
    </div>
  ),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Tooltip: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
    <div data-tooltip={String(title)}>{children}</div>
  ),
  TooltipGroup: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => ({
    axis: 'axis',
    block: 'block',
    blockEmpty: 'blockEmpty',
    blockLoading: 'blockLoading',
    container: 'container',
    dayLabel: 'dayLabel',
    legend: 'legend',
    row: 'row',
    rows: 'rows',
    legendBlock: 'legendBlock',
    scrollContainer: 'scrollContainer',
    slot: 'slot',
  }),
  keyframes: () => 'keyframes',
}));

const LABELS = { less: 'Less', more: 'More' };
const COLORS = ['#eee', '#g2', '#g4', '#g6', '#g8'];

const renderGrid = (props: Partial<Parameters<typeof ActivityHourGrid>[0]> = {}) =>
  render(
    <ActivityHourGrid
      colors={COLORS}
      customTooltip={(cell) => `${cell.label} · ${cell.count}`}
      labels={LABELS}
      {...props}
    />,
  );

const blocks = (container: HTMLElement) => [...container.querySelectorAll('[data-level]')];

describe('ActivityHourGrid', () => {
  it('drawsOneBlockPerCoveredHourUnderAnHourAxis', () => {
    const { container } = renderGrid({
      data: [
        { bucket: '2026-08-16T00:00', count: 0, level: 0 },
        { bucket: '2026-08-16T09:00', count: 1200, level: 3 },
      ],
    });

    expect(blocks(container)).toHaveLength(2);
    // The colour scale is the calendar's: level 0 is the empty fill, 3 the fourth step.
    expect(blocks(container).map((block) => block.getAttribute('data-level'))).toEqual(['0', '3']);
    // The axis prints 00 / 06 / 12 / 18 and leaves the hours between them blank.
    expect(container.querySelector('.axis')?.textContent).toBe('00061218');
  });

  it('keepsTheUncoveredHoursAsEmptySlotsSoTheAxisStaysAligned', () => {
    const { container } = renderGrid({
      data: [{ bucket: '2026-08-16T09:00', count: 4, level: 2 }],
    });

    // 24 slots on the row plus 24 on the axis; only the covered hour draws a block.
    expect(container.querySelectorAll('.row .slot')).toHaveLength(24);
    expect(container.querySelectorAll('.blockEmpty')).toHaveLength(23);
    expect(blocks(container)).toHaveLength(1);
  });

  it('labelsTheTooltipAndTheRowWhenTheWindowStraddlesMidnight', () => {
    const { container } = renderGrid({
      data: [
        { bucket: '2026-08-15T23:00', count: 4, level: 2 },
        { bucket: '2026-08-16T00:00', count: 7, level: 1 },
      ],
    });

    expect(container.querySelectorAll('.row')).toHaveLength(2);
    expect(
      [...container.querySelectorAll('.row .dayLabel')].map((node) => node.textContent),
    ).toEqual(['8/15', '8/16']);
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-tooltip]')].map(
        (node) => node.dataset.tooltip,
      ),
    ).toEqual(['8/15 23:00 · 4', '8/16 00:00 · 7']);
  });

  it('showsTheSameLegendTheCalendarDoes', () => {
    const { container } = renderGrid({
      data: [{ bucket: '2026-08-16T09:00', count: 4, level: 2 }],
    });

    expect(screen.getByText('Less')).toBeTruthy();
    expect(screen.getByText('More')).toBeTruthy();
    // One swatch per level, level 0 included.
    expect(container.querySelectorAll('.legend .legendBlock')).toHaveLength(5);
  });

  it('drawsAPulsingEmptyStripWithoutALegendWhileLoading', () => {
    const { container } = renderGrid({ loading: true });

    expect(container.querySelectorAll('.blockLoading')).toHaveLength(24);
    expect(container.querySelector('.legend')).toBeNull();
    expect(container.querySelectorAll('[data-tooltip]')).toHaveLength(0);
  });

  it('keepsTheStripInPlaceWhenTheWindowHasNoActivityAtAll', () => {
    const { container } = renderGrid({ data: [] });

    expect(container.querySelectorAll('.row .block')).toHaveLength(24);
    expect(container.querySelectorAll('.blockLoading')).toHaveLength(0);
    expect(screen.getByText('Less')).toBeTruthy();
  });

  it('tightensTheGapAndTheRadiusOnMobile', () => {
    // The squares themselves are fluid — they always fill the row, so what a phone
    // changes is the gap between them and how round they are.
    renderGrid({ data: [{ bucket: '2026-08-16T09:00', count: 1, level: 1 }], mobile: true });

    const root = screen.getByTestId('grid-root').style;
    expect(root.getPropertyValue('--activity-hour-gap')).toBe('3px');
    expect(root.getPropertyValue('--activity-hour-radius')).toBe('2px');
    // Nothing caps the block any more: a wide card gets bigger squares, not a blank strip.
    expect(root.getPropertyValue('--activity-hour-max-size')).toBe('');
  });
});
