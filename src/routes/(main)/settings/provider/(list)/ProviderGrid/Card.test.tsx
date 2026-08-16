import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderSettingsContext } from '../../features/ModelList/ProviderSettingsContext';
import Card from './Card';

/** Keys the active locale actually translates; everything else falls back like i18next. */
const translations = vi.hoisted(() => ({ value: {} as Record<string, string> }));

vi.mock('./EnableSwitch', () => ({ default: () => <div data-testid="enable-switch" /> }));

vi.mock('@/business/client/features/BrandingProviderCard', () => ({
  BrandingProviderCard: () => null,
}));

vi.mock('@/hooks/useIsDark', () => ({ useIsDark: () => false }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      translations.value[key] ?? options?.defaultValue ?? key,
  }),
}));

const cardProps = {
  enabled: true,
  id: 'chatgpt',
  name: 'ChatGPT',
  onProviderSelect: vi.fn(),
  source: 'builtin' as const,
};

beforeEach(() => {
  translations.value = {};
});

describe('ProviderGrid Card shared OAuth providers', () => {
  it('renders the enable switch without a shared-account tag on the user surface', () => {
    render(<Card {...cardProps} />);

    expect(screen.getByTestId('enable-switch')).toBeTruthy();
    expect(screen.queryByText('providerModels.config.sharedOAuth.tag')).toBeNull();
  });

  it('labels chatgptweb as a shared account on the admin surface too', () => {
    render(
      <ProviderSettingsContext value={{ hidePersonalAuth: true }}>
        <Card {...cardProps} id="chatgptweb" name="ChatGPT Web" />
      </ProviderSettingsContext>,
    );

    expect(screen.getByText('providerModels.config.sharedOAuth.tag')).toBeTruthy();
  });

  it('keeps the enable switch and labels the shared account on the admin surface', () => {
    render(
      <ProviderSettingsContext value={{ hidePersonalAuth: true }}>
        <Card {...cardProps} />
      </ProviderSettingsContext>,
    );

    expect(screen.getByTestId('enable-switch')).toBeTruthy();
    expect(screen.getByText('providerModels.config.sharedOAuth.tag')).toBeTruthy();
  });
});

describe('ProviderGrid Card title', () => {
  it('shows the localized name where the providers namespace really translates it', () => {
    translations.value = { 'chatgptweb.name': 'ChatGPT 网页版' };

    render(<Card {...cardProps} id="chatgptweb" name="ChatGPT Web" />);

    // The wordmark's label is baked in English, so a translated provider has to be text —
    // otherwise the card contradicts the sidebar item right next to it.
    expect(screen.getByText('ChatGPT 网页版')).toBeTruthy();
    expect(screen.queryByText('ChatGPT Web')).toBeNull();
  });

  it('keeps the wordmark where the localized name only repeats the card name', () => {
    // en-US ships `chatgptweb.name` with the very same value.
    translations.value = { 'chatgptweb.name': 'ChatGPT Web' };

    render(<Card {...cardProps} id="chatgptweb" name="ChatGPT Web" />);

    expect(screen.queryByText('ChatGPT 网页版')).toBeNull();
  });

  it('leaves brand-name providers on their wordmark', () => {
    // The namespace deliberately ships no `<id>.name` for brands like ChatGPT or Anthropic.
    render(<Card {...cardProps} />);

    expect(screen.queryByText('ChatGPT')).toBeNull();
  });
});
