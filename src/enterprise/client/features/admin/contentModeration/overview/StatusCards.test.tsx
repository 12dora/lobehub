// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ContentModerationOverview } from '@/types/platform/contentModeration';

import StatusCards from './StatusCards';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('@lobehub/ui', () => ({
  Icon: () => <span />,
  Tag: ({ children }: { children?: ReactNode }) => <span data-testid="tag">{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
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

const renderCards = (data: ContentModerationOverview, canManage = true) => {
  const onClearCache = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <StatusCards
      canManage={canManage}
      clearing={false}
      data={data}
      onClearCache={onClearCache}
      onOpenSettings={onOpenSettings}
    />,
  );
  return { onClearCache, onOpenSettings };
};

describe('StatusCards', () => {
  it('says the classifier has no samples rather than claiming it is healthy', () => {
    renderCards(overview({ classifier: { health: null, kind: 'llm_judge' } }));
    expect(screen.getByText('contentModeration.overview.health.unknown')).toBeTruthy();
    expect(screen.getByText('contentModeration.overview.healthNoSamples')).toBeTruthy();
  });

  it('reports a failing classifier from its success rate', () => {
    renderCards(
      overview({
        classifier: {
          health: { avgLatencyMs: 900, sampleSize: 100, successRate: 0.4 },
          kind: 'moderations_api',
          label: 'omni-moderation-latest',
        },
      }),
    );
    expect(screen.getByText('contentModeration.overview.health.error')).toBeTruthy();
    expect(screen.getByText('omni-moderation-latest')).toBeTruthy();
  });

  it('warns in place when no downgrade target is configured', () => {
    renderCards(overview());
    expect(screen.getByText('contentModeration.overview.downgradeMissing')).toBeTruthy();
    expect(screen.getByText('contentModeration.overview.downgradeMissingTag')).toBeTruthy();
  });

  it('shows the configured downgrade target instead of the warning', () => {
    renderCards(overview({ downgrade: { model: 'gpt-4o-mini', provider: 'openai' } }));
    expect(screen.getByText('openai / gpt-4o-mini')).toBeTruthy();
    expect(screen.queryByText('contentModeration.overview.downgradeMissingTag')).toBeNull();
  });

  it('jumps to the settings tab from the mode card', () => {
    const { onOpenSettings } = renderCards(overview());
    fireEvent.click(screen.getByText('contentModeration.overview.openSettings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('clears the cache only with the manage permission', () => {
    const granted = renderCards(overview());
    fireEvent.click(screen.getByText('contentModeration.overview.clearCache'));
    expect(granted.onClearCache).toHaveBeenCalledTimes(1);
  });

  it('disables the cache button for a read-only admin', () => {
    renderCards(overview(), false);
    expect(
      (screen.getByText('contentModeration.overview.clearCache') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
