import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ALL_MODULES_ENABLED } from '@/const/platform/modules';

import ModuleSummaryBar from './ModuleSummaryBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const entries = Object.entries(options ?? {}).filter(([name]) => name !== 'defaultValue');
      if (entries.length === 0) return key;
      return `${key}(${entries.map(([name, value]) => `${name}=${String(value)}`).join(',')})`;
    },
  }),
}));

describe('ModuleSummaryBar external dependencies', () => {
  it('keeps the joined dependency list on one line, with the rest in a tooltip', () => {
    // Everything on ⇒ the longest list the page can produce, which is what used to wrap.
    render(<ModuleSummaryBar draft={ALL_MODULES_ENABLED} restartRequiredCount={0} />);

    const joined = [
      'modules.deps.externalService',
      'modules.deps.redis',
      'modules.deps.s3',
      'modules.deps.searxng',
    ].join(' · ');

    // A single node holding the whole list — not a wrapped set of chips.
    const value = screen.getByText(joined);
    expect(value.textContent).toBe(joined);

    // The row must stay one line high; the overflow tooltip carries what does not fit.
    const style = window.getComputedStyle(value);
    expect(style.whiteSpace).toBe('nowrap');
    expect(style.overflow).toBe('hidden');
    expect(style.textOverflow).toBe('ellipsis');
    // Without this the flex column refuses to shrink and the text wraps instead of truncating.
    expect(Number.parseFloat(style.minWidth)).toBe(0);
    expect(Number.parseFloat(window.getComputedStyle(value.parentElement!).minWidth)).toBe(0);
  });

  it('shows the empty-state copy when nothing external is needed', () => {
    const none = Object.fromEntries(
      Object.keys(ALL_MODULES_ENABLED).map((id) => [id, false]),
    ) as typeof ALL_MODULES_ENABLED;

    render(<ModuleSummaryBar draft={none} restartRequiredCount={0} />);

    expect(screen.getByText('modules.summary.noExternalDeps')).toBeTruthy();
  });
});
