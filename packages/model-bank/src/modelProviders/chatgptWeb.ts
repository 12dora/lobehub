import type { ModelProviderCard } from '../types';

/**
 * ChatGPT Web talks to the chatgpt.com conversation backend that powers the
 * chatgpt.com web app — the same subscription, but with the web-only features
 * (web search, image generation, file upload) instead of the Codex/Responses
 * surface used by the `chatgpt` provider.
 *
 * The connect flow is an OAuth authorization-code + PKCE grant where the user
 * signs in in a browser and pastes the callback URL back into the app, because
 * the redirect URI belongs to OpenAI and cannot point at this deployment.
 */
const ChatGPTWeb: ModelProviderCard = {
  chatModels: [],
  checkModel: 'auto',
  description:
    'Use your ChatGPT subscription through the chatgpt.com web backend, with web search, image generation and file upload — no OpenAI Platform API key needed.',
  disableBrowserRequest: true,
  id: 'chatgptweb',
  modelsUrl: 'https://chatgpt.com',
  name: 'ChatGPT Web',
  settings: {
    authType: 'oauthDeviceFlow',
    disableBrowserRequest: true,
    // The ChatGPT Web runtime uploads user documents to chatgpt.com and attaches
    // them to the conversation, so it is the only provider that understands the
    // native `file_url` content part (see `isProviderNativeFileInput`).
    nativeFileInput: true,
    oauthDeviceFlow: {
      allowAccessTokenPaste: true,
      authorizationCode: {
        audience: 'https://api.openai.com/v1',
        authorizeEndpoint: 'https://auth.openai.com/api/accounts/authorize',
        redirectUri: 'https://platform.openai.com/auth/callback',
      },
      clientId: 'app_2SKx67EdpoN0G6j64rFvigXD',
      // required by the type; unused for the authorization-code paste flow
      deviceCodeEndpoint: 'https://auth.openai.com/api/accounts/authorize',
      grantFlow: 'authorization_code_paste',
      refreshTokenGrant: true,
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      tokenEndpoint: 'https://auth.openai.com/oauth/token',
      tokenExchangeEndpoint: 'https://auth.openai.com/api/accounts/oauth/token',
    },
    sdkType: 'openai',
    searchMode: 'params',
    showApiKey: false,
    showChecker: true,
    showModelFetcher: true,
  },
  url: 'https://chatgpt.com',
};

export default ChatGPTWeb;
