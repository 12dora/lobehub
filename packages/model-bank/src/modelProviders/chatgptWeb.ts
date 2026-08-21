import type { ModelProviderCard } from '../types';

/**
 * ChatGPT Web talks to the chatgpt.com conversation backend that powers the
 * chatgpt.com web app — the same subscription, but with the web-only features
 * (web search, image generation, file upload) instead of the Codex/Responses
 * surface used by the `chatgpt` provider.
 *
 * Connecting is a one-time paste of the chatgpt.com web session, which the server
 * then spends at `chatgpt.com/api/auth/session` to mint access tokens exactly as
 * the web app does — sign in once, renewed from then on (`webSessionOnly`).
 *
 * The authorization-code fields below are NOT the connect route: that grant asks
 * for the platform API audience and lands on platform.openai.com, which is not the
 * chatgpt.com subscription this provider serves. They stay declared because
 * connections stored before `webSessionOnly` still renew through that grant.
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
    // Web-app provider: skip generic date / model-info / default-assistant
    // boilerplate (see `isWebAppProvider`).
    webApp: true,
    // The ChatGPT Web runtime uploads user documents to chatgpt.com and attaches
    // them to the conversation (`isProviderNativeFileInput`). The Codex
    // `chatgpt` provider also opts in, emitting Responses `input_file` instead.
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
      /**
       * 24 h, not the 2-minute default: OpenAI drops a refresh token that goes unused, so
       * the renewal window has to be wide enough that a connection touched once a day
       * keeps rolling. Pairs with the 3-day forced keepalive for connections that are not
       * touched at all.
       */
      refreshSkewMs: 24 * 60 * 60 * 1000,
      refreshTokenGrant: true,
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      tokenEndpoint: 'https://auth.openai.com/oauth/token',
      tokenExchangeEndpoint: 'https://auth.openai.com/api/accounts/oauth/token',
      webSessionOnly: true,
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
