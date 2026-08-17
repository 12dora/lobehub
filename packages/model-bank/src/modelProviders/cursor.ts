import type { ModelProviderCard } from '../types';

/**
 * Cursor CLI models (Composer, Grok, Claude, GPT, Gemini) through one Cursor
 * account — the same access as `cursor-agent`, no per-model API keys.
 *
 * Auth is a device-flow *shape* (URL + poll), not RFC 8628: the admin opens
 * `loginDeepControl`, the server polls `/auth/poll`. A dashboard API key can
 * be pasted instead and is exchanged at `/auth/exchange_user_api_key`.
 */
const Cursor: ModelProviderCard = {
  // Where a dashboard API key is created — the connect panels link the hint at it instead of
  // naming a page the operator then has to find.
  apiKeyUrl: 'https://cursor.com/dashboard',
  chatModels: [],
  checkModel: 'composer-2.5',
  description:
    "Use Cursor models (Composer, Grok, Claude, GPT, Gemini) through the platform's Cursor account — the same access as the Cursor CLI, no separate model API keys.",
  disableBrowserRequest: true,
  id: 'cursor',
  modelsUrl: 'https://cursor.com/docs/models',
  name: 'Cursor',
  settings: {
    authType: 'oauthDeviceFlow',
    // OAuth tokens are refreshed and persisted server-side; browser requests
    // would bypass the refresh pipeline, so they are hard-disabled.
    disableBrowserRequest: true,
    oauthDeviceFlow: {
      allowAccessTokenPaste: true,
      clientId: 'cursor-cli',
      defaultPollingInterval: 3,
      deviceCodeEndpoint: 'https://cursor.com/loginDeepControl',
      pastedCredentialKind: 'apiKey',
      refreshSkewMs: 24 * 60 * 60 * 1000,
      refreshTokenGrant: true,
      scopes: [],
      tokenEndpoint: 'https://api2.cursor.sh/auth/poll',
      tokenExchangeEndpoint: 'https://api2.cursor.sh/auth/exchange_user_api_key',
    },
    sdkType: 'openai',
    showApiKey: false,
    showChecker: true,
    showModelFetcher: true,
  },
  url: 'https://cursor.com',
};

export default Cursor;
