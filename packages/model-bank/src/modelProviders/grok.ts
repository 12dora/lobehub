import type { ModelProviderCard } from '../types';

/**
 * Grok Build / SuperGrok subscription access to Grok models via xAI OAuth
 * device flow (RFC 8628), talking to the Grok Build CLI proxy
 * (`https://cli-chat-proxy.grok.com/v1`) rather than `api.x.ai`.
 *
 * The client_id below is xAI's public Grok-CLI OAuth client — the same one
 * used by the Grok Build CLI and SuperGrok. Requests require the CLI version
 * headers (`x-grok-client-version` / `x-grok-client-identifier`) which the
 * runtime injects; the proxy rejects calls without them.
 */
const Grok: ModelProviderCard = {
  chatModels: [],
  checkModel: 'grok-4.6',
  description:
    'Use Grok models with your Grok Build (SuperGrok) subscription — the same access as the Grok Build CLI, no xAI API key required.',
  disableBrowserRequest: true,
  id: 'grok',
  modelsUrl: 'https://docs.x.ai/docs/models',
  name: 'Grok',
  settings: {
    authType: 'oauthDeviceFlow',
    // OAuth tokens are refreshed and persisted server-side; browser requests
    // would bypass the refresh pipeline, so they are hard-disabled.
    disableBrowserRequest: true,
    oauthDeviceFlow: {
      clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
      defaultPollingInterval: 5,
      deviceCodeEndpoint: 'https://auth.x.ai/oauth2/device/code',
      refreshTokenGrant: true,
      scopes: [
        'openid',
        'profile',
        'email',
        'offline_access',
        'grok-cli:access',
        'api:access',
        'conversations:read',
        'conversations:write',
      ],
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    },
    sdkType: 'openai',
    searchMode: 'params',
    showApiKey: false,
    showChecker: true,
    showModelFetcher: true,
  },
  url: 'https://grok.com',
};

export default Grok;
