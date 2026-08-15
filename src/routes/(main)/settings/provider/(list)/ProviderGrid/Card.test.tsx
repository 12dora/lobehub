import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProviderSettingsContext } from '../../features/ModelList/ProviderSettingsContext';
import Card from './Card';

vi.mock('./EnableSwitch', () => ({ default: () => <div data-testid="enable-switch" /> }));

vi.mock('@/business/client/features/BrandingProviderCard', () => ({
  BrandingProviderCard: () => null,
}));

vi.mock('@/hooks/useIsDark', () => ({ useIsDark: () => false }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const cardProps = {
  enabled: true,
  id: 'chatgpt',
  name: 'ChatGPT',
  onProviderSelect: vi.fn(),
  source: 'builtin' as const,
};

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
