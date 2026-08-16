// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MODERATION_CATEGORIES } from '@/const/platform/contentModeration';

import CategoryScoreBars from './CategoryScoreBars';

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

describe('CategoryScoreBars', () => {
  it('renders one bar per platform category', () => {
    render(<CategoryScoreBars scores={{ sexual: 0.9 }} thresholds={undefined} />);
    for (const category of MODERATION_CATEGORIES) {
      expect(screen.getByTestId(`category-bar-${category}`)).toBeTruthy();
    }
  });

  it('draws the threshold marker from the decision-time snapshot', () => {
    render(
      <CategoryScoreBars
        scores={{ sexual: 0.7 }}
        thresholds={{ sexual: { action: 'block', threshold: 0.65 } }}
      />,
    );
    const marker = screen.getByTestId('category-threshold-sexual');
    expect(marker.getAttribute('style')).toContain('65%');
    // Categories missing from the snapshot get no marker at all — never a guessed default.
    expect(screen.queryByTestId('category-threshold-violence')).toBeNull();
  });

  it('shows the score next to the snapshot threshold, sorted by score', () => {
    render(
      <CategoryScoreBars
        scores={{ sexual: 0.2, violence: 0.8 }}
        thresholds={{
          sexual: { action: 'block', threshold: 0.65 },
          violence: { action: 'log', threshold: 0.9 },
        }}
      />,
    );
    const bars = screen.getAllByTestId(/^category-bar-/);
    expect(bars[0].dataset.testid ?? bars[0].getAttribute('data-testid')).toBe(
      'category-bar-violence',
    );
    expect(screen.getByTestId('category-bar-sexual').textContent).toContain('0.20 / 0.65');
  });
});
