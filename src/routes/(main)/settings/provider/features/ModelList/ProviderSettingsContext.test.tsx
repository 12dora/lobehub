import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ModelList from './index';
import { ProviderSettingsContext } from './ProviderSettingsContext';

vi.mock('./ModelTitle', async () => {
  const React = await import('react');
  const { ProviderSettingsContext: Ctx } = await import('./ProviderSettingsContext');
  const MockModelTitle = ({ showModelFetcher }: { showModelFetcher?: boolean }) => {
    const ctx = React.use(Ctx);
    return (
      <div>
        <span data-testid="fetcher-flag">{String(showModelFetcher)}</span>
        <span data-testid="hide-fetch-inner">{String(ctx.hideFetchOnClient)}</span>
      </div>
    );
  };
  return { default: MockModelTitle };
});

vi.mock('./SkeletonList', () => ({ default: () => null }));
vi.mock('./EmptyModels', () => ({ default: () => null }));
vi.mock('./EnabledModelList', () => ({ default: () => null }));
vi.mock('./DisabledModels', () => ({ default: () => null }));
vi.mock('./SearchResult', () => ({ default: () => null }));

vi.mock('@/store/aiInfra', () => ({
  aiModelSelectors: {
    filteredAiProviderModelList: () => [],
    isEmptyAiProviderModelList: () => true,
  },
  useScopedAiInfraStore: (selector: (s: any) => unknown) =>
    selector({
      modelSearchKeyword: '',
      useFetchAiProviderModels: () => ({ error: null, isLoading: false }),
    }),
}));

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('ModelList ProviderSettingsContext merge', () => {
  it('preserves outer hideFetchOnClient / showModelFetcher through ModelList', () => {
    render(
      <ProviderSettingsContext value={{ hideFetchOnClient: true, showModelFetcher: false }}>
        <ModelList id="openai" />
      </ProviderSettingsContext>,
    );
    expect(screen.getByTestId('fetcher-flag').textContent).toBe('false');
    expect(screen.getByTestId('hide-fetch-inner').textContent).toBe('true');
  });
});
