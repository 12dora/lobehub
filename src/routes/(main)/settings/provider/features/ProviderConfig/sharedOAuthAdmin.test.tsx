import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProviderSettingsContext } from '../ModelList/ProviderSettingsContext';
import ProviderConfig from './index';

vi.mock('./EnableSwitch', () => ({ default: () => <div data-testid="enable-switch" /> }));
vi.mock('./OAuthDeviceFlowAuth', () => ({ default: () => <div data-testid="personal-oauth" /> }));
vi.mock('./Checker', () => ({ default: () => <div data-testid="checker" /> }));
vi.mock('./UpdateProviderInfo', () => ({ default: () => null }));

vi.mock('@/libs/trpc/client', () => ({
  lambdaQuery: { oauthDeviceFlow: { getAuthStatus: { useQuery: () => ({ data: undefined }) } } },
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));

vi.mock('@/store/aiInfra', () => ({
  aiProviderSelectors: {
    isAiProviderConfigLoading: () => () => false,
    isProviderConfigUpdating: () => () => false,
    isProviderEnabled: () => () => true,
    providerConfigById: () => () => undefined,
    providerDetailById: () => () => undefined,
  },
  useAiInfraStoreApi: () => ({ getState: () => ({}) }),
  useScopedAiInfraStore: (selector: (s: any) => unknown) =>
    selector({ updateAiProviderConfig: vi.fn() }),
}));

vi.mock('@/store/serverConfig', () => ({
  serverConfigSelectors: { enableBusinessFeatures: () => false },
  useServerConfigStore: (selector: (s: any) => unknown) => selector({}),
}));

vi.mock('react-i18next', () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
  useTranslation: () => ({ t: (key: string) => key }),
}));

const oauthSettings = { authType: 'oauthDeviceFlow' as const, showApiKey: false };

const sharedPanel = (providerId: string) => <div data-testid="shared-panel">{providerId}</div>;

describe('ProviderConfig shared OAuth surfaces', () => {
  it('user surface keeps the personal connect panel and never shows the shared panel', () => {
    render(<ProviderConfig id="chatgpt" name="ChatGPT" settings={oauthSettings} />);

    expect(screen.getByTestId('personal-oauth')).toBeTruthy();
    expect(screen.queryByTestId('shared-panel')).toBeNull();
  });

  it('admin surface renders the shared panel + enable switch and suppresses personal connect', () => {
    render(
      <ProviderSettingsContext value={{ hidePersonalAuth: true, sharedOAuthPanel: sharedPanel }}>
        <ProviderConfig id="chatgpt" name="ChatGPT" settings={oauthSettings} />
      </ProviderSettingsContext>,
    );

    expect(screen.getByTestId('shared-panel').textContent).toBe('chatgpt');
    expect(screen.getByTestId('enable-switch')).toBeTruthy();
    expect(screen.queryByTestId('personal-oauth')).toBeNull();
    expect(screen.getByText('providerModels.config.sharedOAuth.tag')).toBeTruthy();
  });

  it('admin surface explains per-user-only device flow providers (githubcopilot)', () => {
    render(
      <ProviderSettingsContext value={{ hidePersonalAuth: true, sharedOAuthPanel: sharedPanel }}>
        <ProviderConfig id="githubcopilot" name="GitHub Copilot" settings={oauthSettings} />
      </ProviderSettingsContext>,
    );

    expect(screen.getByText('providerModels.config.sharedOAuth.perUserOnlyNotice')).toBeTruthy();
    expect(screen.queryByTestId('shared-panel')).toBeNull();
    expect(screen.getByTestId('enable-switch')).toBeTruthy();
  });
});
