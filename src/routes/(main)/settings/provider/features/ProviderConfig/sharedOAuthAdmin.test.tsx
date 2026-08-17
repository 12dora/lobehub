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
    // Added when the header started showing the provider description; without it every case
    // in this file threw before rendering anything.
    providerDescriptionById: () => () => undefined,
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

  it('gives the paste-flow provider (chatgptweb) the shared panel like any rotating-refresh one', () => {
    render(
      <ProviderSettingsContext value={{ hidePersonalAuth: true, sharedOAuthPanel: sharedPanel }}>
        <ProviderConfig id="chatgptweb" name="ChatGPT Web" settings={oauthSettings} />
      </ProviderSettingsContext>,
    );

    expect(screen.getByTestId('shared-panel').textContent).toBe('chatgptweb');
    expect(screen.queryByTestId('personal-oauth')).toBeNull();
    expect(screen.queryByText('providerModels.config.sharedOAuth.perUserOnlyNotice')).toBeNull();
  });

  it('keeps the personal connect panel for chatgptweb on the user surface', () => {
    render(<ProviderConfig id="chatgptweb" name="ChatGPT Web" settings={oauthSettings} />);

    expect(screen.getByTestId('personal-oauth')).toBeTruthy();
    expect(screen.queryByTestId('shared-panel')).toBeNull();
  });

  it('describes the connectivity check by what the form actually holds', () => {
    // Grok / Cursor connect with an account: no API-key field, no proxy URL. Naming them told
    // the operator to check fields that are not on the page, and promised encryption of a
    // secret this form never collects.
    render(
      <ProviderSettingsContext value={{ hidePersonalAuth: true, sharedOAuthPanel: sharedPanel }}>
        <ProviderConfig id="cursor" name="Cursor" settings={oauthSettings} />
      </ProviderSettingsContext>,
    );

    expect(screen.getByText('providerModels.config.checker.descNoCredential')).toBeTruthy();
    expect(screen.queryByText('providerModels.config.checker.desc')).toBeNull();
    expect(screen.queryByText('providerModels.config.aesGcm')).toBeNull();
  });

  it('names only the API Key where that is the single field on the form (openai)', () => {
    render(<ProviderConfig id="openai" name="OpenAI" settings={{ showApiKey: true }} />);

    expect(screen.getByText('providerModels.config.checker.descApiKeyOnly')).toBeTruthy();
    // The combined sentence names a proxy URL this form does not offer.
    expect(screen.queryByText('providerModels.config.checker.desc')).toBeNull();
    expect(screen.getByText('providerModels.config.aesGcm')).toBeTruthy();
  });

  it('names only the endpoint for a provider that takes no API Key (ollama)', () => {
    render(
      <ProviderConfig
        id="ollama"
        name="Ollama"
        settings={{ proxyUrl: { placeholder: 'http://127.0.0.1:11434' }, showApiKey: false }}
      />,
    );

    expect(screen.getByText('providerModels.config.checker.descEndpointOnly')).toBeTruthy();
    expect(screen.queryByText('providerModels.config.checker.desc')).toBeNull();
    expect(screen.queryByText('providerModels.config.checker.descApiKeyOnly')).toBeNull();
    // The proxy URL is stored encrypted like any credential, so the footer stays.
    expect(screen.getByText('providerModels.config.aesGcm')).toBeTruthy();
  });

  it('keeps the combined wording where the form really collects both', () => {
    render(
      <ProviderConfig
        id="openai"
        name="OpenAI"
        settings={{ proxyUrl: { placeholder: 'https://api.openai.com/v1' }, showApiKey: true }}
      />,
    );

    expect(screen.getByText('providerModels.config.checker.desc')).toBeTruthy();
    expect(screen.getByText('providerModels.config.aesGcm')).toBeTruthy();
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
