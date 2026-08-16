// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ActivityLegend from './ActivityLegend';

vi.mock('antd-style', () => ({
  createStaticStyles: () => ({ block: 'block', legend: 'legend' }),
}));

const LABELS = { less: 'Less', more: 'More' };
const COLORS = ['#eeeeee', '#c2e5a0', '#95d475', '#5cb85c', '#2f7d32'];

describe('ActivityLegend', () => {
  it('drawsOneSwatchPerLevelWithTheCalendarsColours', () => {
    const { container } = render(<ActivityLegend colors={COLORS} labels={LABELS} />);

    const swatches = [...container.querySelectorAll<HTMLElement>('.legend .block')];
    expect(swatches).toHaveLength(5);
    expect(swatches.map((node) => node.style.background)).toEqual(COLORS);
    // The key is a fixed size, not the grid's fluid square: nothing is set inline.
    expect(swatches.every((node) => node.style.width === '')).toBe(true);
    expect(screen.getByText('Less')).toBeTruthy();
    expect(screen.getByText('More')).toBeTruthy();
  });
});
