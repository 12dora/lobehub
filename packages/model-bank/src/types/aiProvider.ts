import { z } from 'zod';

import type { AiModelForSelect, EnabledAiModel, ModelSearchImplementType } from './aiModel';

export type ResponseAnimationStyle = 'smooth' | 'fadeIn' | 'none';
export type ResponseAnimation =
  | {
      speed?: number;
      text?: ResponseAnimationStyle;
    }
  | ResponseAnimationStyle;

export const AiProviderSourceEnum = {
  Builtin: 'builtin',
  Custom: 'custom',
} as const;
export type AiProviderSourceType = (typeof AiProviderSourceEnum)[keyof typeof AiProviderSourceEnum];

/**
 * Authentication type for AI providers
 */
export const AiProviderAuthTypeEnum = {
  ApiKey: 'apiKey',
  OAuthDeviceFlow: 'oauthDeviceFlow',
} as const;

export type AiProviderAuthType =
  (typeof AiProviderAuthTypeEnum)[keyof typeof AiProviderAuthTypeEnum];

/**
 * OAuth Device Flow configuration
 */
export interface OAuthDeviceFlowConfig {
  /**
   * Whether the provider additionally accepts a manually pasted access token as
   * a fallback credential (no refresh token, so it cannot be auto-renewed).
   */
  allowAccessTokenPaste?: boolean;
  /**
   * Endpoints used when `grantFlow` is `authorization_code_paste`.
   */
  authorizationCode?: {
    /**
     * Optional `audience` parameter sent to the authorize endpoint.
     */
    audience?: string;
    /**
     * URL the user opens in a browser to authorize the app.
     */
    authorizeEndpoint: string;
    /**
     * Redirect URI registered for the client. The user lands on it after
     * authorizing and pastes the resulting URL back into the app.
     */
    redirectUri: string;
  };
  /**
   * OAuth client ID
   */
  clientId: string;
  /**
   * Default polling interval in seconds
   * @default 5
   */
  defaultPollingInterval?: number;
  /**
   * URL to request device code
   */
  deviceCodeEndpoint: string;
  /**
   * Which OAuth grant the connect flow uses.
   * - `device_code`: RFC 8628 device authorization grant (user code + polling)
   * - `authorization_code_paste`: authorization code + PKCE where the user pastes
   *   the callback URL back into the app (no local redirect listener)
   * @default 'device_code'
   */
  grantFlow?: 'device_code' | 'authorization_code_paste';
  /**
   * What the pasted-credential field actually holds when `allowAccessTokenPaste` is on.
   * - `accessToken`: a ready-to-use bearer (ChatGPT Web's fallback).
   * - `apiKey`: a dashboard API key that the server must exchange before storing
   *   (`oauthAccessToken` / `oauthRefreshToken`). Defaults to `accessToken` when omitted
   *   so existing paste-flow cards keep their wording.
   */
  pastedCredentialKind?: 'accessToken' | 'apiKey';
  /**
   * How long BEFORE the access token expires the server starts refreshing it.
   *
   * Defaults to 2 minutes, which is the right budget for a provider that hands out
   * short-lived access tokens and keeps the refresh token valid regardless of use.
   * Providers that invalidate an UNUSED refresh token (ChatGPT Web) need a far wider
   * window — refreshing a full day ahead means a connection that is idle for a few days
   * still renews from a request that arrives well inside the grant's lifetime, instead of
   * waking up 2 minutes before expiry with a refresh token the provider already dropped.
   *
   * @default 120_000
   */
  refreshSkewMs?: number;
  /**
   * Whether the provider issues a refresh_token (e.g. via `offline_access`
   * scope) that the server should use to renew the access token before it
   * expires. Providers with rotating refresh tokens (e.g. xAI) rely on the
   * server-side refresh pipeline persisting the rotated pair on every renewal.
   */
  refreshTokenGrant?: boolean;
  /**
   * OAuth scopes
   */
  scopes: string[];
  /**
   * URL to exchange device code for access token
   */
  tokenEndpoint: string;
  /**
   * Optional: Provider-specific token exchange endpoint (e.g., GitHub Copilot)
   */
  tokenExchangeEndpoint?: string;
  /**
   * Connect ONLY via a pasted web session: the authorization-code UI is hidden and a
   * callback exchange is rejected server-side.
   *
   * Set where the authorization page signs the user into a DIFFERENT product than the one
   * the provider talks to (ChatGPT Web: the authorize call has the platform API as its
   * audience and lands on platform.openai.com, which is not the chatgpt.com subscription).
   * The `authorizationCode` / `clientId` / `tokenEndpoint` fields stay declared regardless:
   * connections stored before the flag was set still renew through that grant.
   *
   * Only meaningful on a card that already connects by paste: `OAuthDeviceFlowConfigSchema`
   * refuses it unless `grantFlow` is `authorization_code_paste` and `allowAccessTokenPaste`
   * is `true`, because the session-only UI lives inside the paste panel and submits through
   * the pasted-credential gate.
   */
  webSessionOnly?: boolean;
}

/**
 * OAuth Device Flow tokens stored in keyVaults
 */
export interface OAuthDeviceFlowKeyVault {
  /**
   * Provider-specific bearer token (e.g., Copilot token)
   */
  bearerToken?: string;
  /**
   * Bearer token expiration timestamp (ms)
   */
  bearerTokenExpiresAt?: number;
  /**
   * OAuth access token (e.g., GitHub's ghu_xxx)
   */
  oauthAccessToken?: string;
  /**
   * Email of the connected account, shown in the UI so the user can tell which
   * account is currently linked. Never used for authentication.
   */
  oauthAccountEmail?: string;
  /**
   * Provider account identifier associated with the OAuth token.
   * Some OAuth-backed inference endpoints require it as a request header.
   */
  oauthAccountId?: string;
  /**
   * Stable device identifier generated at connect time (`oai-device-id` for
   * ChatGPT Web). Non-secret, but must stay stable for the connection.
   */
  oauthDeviceId?: string;
  /**
   * Timestamp (ms) of the last SUCCESSFUL token refresh — the keepalive anchor.
   *
   * Providers that expire an unused refresh token need a forced renewal on a fixed
   * cadence, and "when did we last renew" is not derivable from the access token alone.
   * Non-secret bookkeeping; it is written by the refresh pipeline, never by a user.
   */
  oauthLastRefreshAt?: number;
  /**
   * Timestamp (ms) of the last FAILED refresh attempt — the backoff anchor.
   *
   * Cleared on the next success. Without it, a provider outage turns every request into
   * another token-endpoint call. Non-secret bookkeeping.
   */
  oauthLastRefreshErrorAt?: number;
  /**
   * OAuth refresh token. May rotate on every refresh (e.g. xAI) — always
   * persist the value returned by the latest refresh response.
   */
  oauthRefreshToken?: string;
  /**
   * OAuth token expiration timestamp (ms)
   */
  oauthTokenExpiresAt?: number;
}

/**
 * only when provider use different sdk
 * we will add a type
 */
export const AiProviderSDKEnum = {
  Anthropic: 'anthropic',
  Azure: 'azure',
  AzureAI: 'azureai',
  Bedrock: 'bedrock',
  Cloudflare: 'cloudflare',
  ComfyUI: 'comfyui',
  Google: 'google',
  Huggingface: 'huggingface',
  Ollama: 'ollama',
  Openai: 'openai',
  Qwen: 'qwen',
  Replicate: 'replicate',
  Router: 'router',
  Volcengine: 'volcengine',
} as const;

export type AiProviderSDKType = (typeof AiProviderSDKEnum)[keyof typeof AiProviderSDKEnum];

const AiProviderSdkTypes = [
  'anthropic',
  'comfyui',
  'openai',
  'ollama',
  'azure',
  'azureai',
  'bedrock',
  'cloudflare',
  'google',
  'huggingface',
  'replicate',
  'router',
  'volcengine',
  'qwen',
] as const satisfies readonly AiProviderSDKType[];

export interface AiProviderSettings {
  /**
   * Authentication type for the provider
   * @default 'apiKey'
   */
  authType?: AiProviderAuthType;
  /**
   * whether provider show browser request option by default
   *
   * @default false
   */
  defaultShowBrowserRequest?: boolean;
  /**
   * some provider server like stepfun and aliyun don't support browser request,
   * So we should disable it
   *
   * @default false
   */
  disableBrowserRequest?: boolean;
  /**
   * Maximum number of tools the provider accepts in a single request.
   * When set, the harness will abort the request before dispatch if the
   * tools array exceeds this count, instead of waiting for an upstream
   * 422 / 400 rejection.
   *
   * Example: GitHub Copilot enforces max 128 tools across all its models.
   */
  maxToolCount?: number;
  /**
   * Maximum serialized tools payload size in bytes before the provider
   * rejects the request (e.g. Cloudflare AI Workers ~100 KB). If unset,
   * only the count-based check (`maxToolCount`) is applied.
   */
  maxToolPayloadBytes?: number;
  /**
   * whether provider support edit model
   *
   * @default true
   */
  modelEditable?: boolean;

  /**
   * Whether the provider runtime can carry a user document as a NATIVE
   * `file_url` content part (uploading the real file upstream) instead of the
   * `<files_info>` text injection.
   *
   * This is a *wire-format* capability of the runtime, deliberately separate
   * from the per-model `abilities.files`: many OpenAI-compatible providers
   * advertise `abilities.files` while their wire format has no file part, so
   * the model ability alone must never switch on native parts.
   *
   * Only honoured on builtin provider cards (see `isProviderNativeFileInput`).
   */
  nativeFileInput?: boolean;

  /**
   * OAuth Device Flow configuration
   * Only used when authType is 'oauthDeviceFlow'
   */
  oauthDeviceFlow?: OAuthDeviceFlowConfig;

  proxyUrl?:
    | {
        desc?: string;
        placeholder: string;
        title?: string;
      }
    | false;

  responseAnimation?: ResponseAnimation;
  /**
   * default openai
   */
  sdkType?: AiProviderSDKType;
  searchMode?: ModelSearchImplementType;
  showAddNewModel?: boolean;
  /**
   * whether show api key in the provider config
   * so provider like ollama don't need api key field
   */
  showApiKey?: boolean;
  /**
   * whether show checker in the provider config
   */
  showChecker?: boolean;
  showDeployName?: boolean;
  showModelFetcher?: boolean;
  supportResponsesApi?: boolean;
  /**
   * Web-app provider: proxies a consumer web app (ChatGPT / Cursor / Grok web). The app already manages date, model identity and its own system prompt, so LobeHub skips the generic date / model-info / default-assistant boilerplate injections.
   *
   * Only honoured on builtin provider cards (see `isWebAppProvider`).
   *
   * @default false
   */
  webApp?: boolean;
}

const ResponseAnimationType = z.enum(['smooth', 'fadeIn', 'none']);

const AiProviderAuthTypes = ['apiKey', 'oauthDeviceFlow'] as const;

/**
 * `webSessionOnly` is not a free-standing switch: the session-only UI is a layout INSIDE the
 * paste panel and it submits through the pasted-credential gate. Declared next to
 * `grantFlow: 'device_code'` it would hide nothing (the device-code UI is a different
 * branch), and declared next to `allowAccessTokenPaste: false` it would render the only
 * offered form straight into a server-side rejection. Both combinations are refused here so
 * the guarantee rests on the contract rather than on every card being authored correctly.
 */
const requireWebSessionOnlyPasteFlow = (
  config: { allowAccessTokenPaste?: boolean; grantFlow?: string; webSessionOnly?: boolean },
  ctx: z.RefinementCtx,
) => {
  if (!config.webSessionOnly) return;

  if (config.grantFlow !== 'authorization_code_paste') {
    ctx.addIssue({
      code: 'custom',
      message: 'webSessionOnly requires grantFlow "authorization_code_paste"',
      path: ['grantFlow'],
    });
  }

  if (config.allowAccessTokenPaste !== true) {
    ctx.addIssue({
      code: 'custom',
      message: 'webSessionOnly requires allowAccessTokenPaste true',
      path: ['allowAccessTokenPaste'],
    });
  }
};

const OAuthDeviceFlowConfigSchema = z
  .object({
    allowAccessTokenPaste: z.boolean().optional(),
    authorizationCode: z
      .object({
        audience: z.string().optional(),
        authorizeEndpoint: z.string(),
        redirectUri: z.string(),
      })
      .optional(),
    clientId: z.string(),
    defaultPollingInterval: z.number().optional(),
    deviceCodeEndpoint: z.string(),
    grantFlow: z.enum(['device_code', 'authorization_code_paste']).optional(),
    pastedCredentialKind: z.enum(['accessToken', 'apiKey']).optional(),
    /**
     * Proactive-refresh window in milliseconds. Integer and non-negative — `.int()` also
     * rejects `NaN`/`Infinity`, which would otherwise poison every expiry comparison.
     * Absent from the schema it was silently stripped from create/update payloads, leaving
     * the runtime on the 2-minute default for providers that declare a wider window.
     */
    refreshSkewMs: z.number().int().nonnegative().optional(),
    refreshTokenGrant: z.boolean().optional(),
    scopes: z.array(z.string()),
    tokenEndpoint: z.string(),
    tokenExchangeEndpoint: z.string().optional(),
    webSessionOnly: z.boolean().optional(),
  })
  .superRefine(requireWebSessionOnlyPasteFlow);

const AiProviderSettingsSchema = z.object({
  authType: z.enum(AiProviderAuthTypes).optional(),
  defaultShowBrowserRequest: z.boolean().optional(),
  disableBrowserRequest: z.boolean().optional(),
  maxToolCount: z.number().optional(),
  maxToolPayloadBytes: z.number().optional(),
  modelEditable: z.boolean().optional(),
  nativeFileInput: z.boolean().optional(),
  oauthDeviceFlow: OAuthDeviceFlowConfigSchema.optional(),
  proxyUrl: z
    .object({
      desc: z.string().optional(),
      placeholder: z.string(),
      title: z.string().optional(),
    })
    .or(z.literal(false))
    .optional(),
  responseAnimation: z
    .object({
      text: ResponseAnimationType.optional(),
      toolsCalling: ResponseAnimationType.optional(),
    })
    .or(ResponseAnimationType)
    .optional(),
  sdkType: z.enum(AiProviderSdkTypes).optional(),
  searchMode: z.enum(['params', 'internal']).optional(),
  showAddNewModel: z.boolean().optional(),
  showApiKey: z.boolean().optional(),
  showChecker: z.boolean().optional(),
  showDeployName: z.boolean().optional(),
  showModelFetcher: z.boolean().optional(),
  supportResponsesApi: z.boolean().optional(),
  webApp: z.boolean().optional(),
});

export interface AiProviderConfig {
  enableResponseApi?: boolean;
}

// create
export const CreateAiProviderSchema = z.object({
  config: z.object({}).passthrough().optional(),
  description: z.string().optional(),
  id: z.string(),
  keyVaults: z.any().optional(),
  logo: z.string().optional(),
  name: z.string(),
  sdkType: z.enum(AiProviderSdkTypes).optional(),
  settings: AiProviderSettingsSchema.optional(),
  source: z.enum(['builtin', 'custom']),
  // checkModel: z.string().optional(),
  // homeUrl: z.string().optional(),
  // modelsUrl: z.string().optional(),
});

export type CreateAiProviderParams = z.infer<typeof CreateAiProviderSchema>;

// List Query

export interface AiProviderListItem {
  description?: string;
  enabled: boolean;
  id: string;
  logo?: string;
  name?: string;
  sort?: number;
  source: AiProviderSourceType;
}

// Detail Query

export interface AiProviderCard {
  /**
   * the default model that used for connection check
   */
  checkModel?: string;
  config: AiProviderSettings;
  description?: string;
  enabled: boolean;
  enabledChatModels: string[];
  /**
   * provider's website url
   */
  homeUrl?: string;
  id: string;
  logo?: string;
  /**
   * the url show the all models in the provider
   */
  modelsUrl?: string;
  /**
   * the name show for end user
   */
  name: string;
}

export interface AiProviderDetailItem {
  /**
   * the default model that used for connection check
   */
  checkModel?: string;
  description?: string;
  enabled: boolean;
  fetchOnClient?: boolean;
  /**
   * provider's website url
   */
  homeUrl?: string;
  id: string;
  keyVaults?: Record<string, any>;
  logo?: string;
  /**
   * the url show the all models in the provider
   */
  modelsUrl?: string;
  /**
   * the name show for end user
   */
  name: string;
  settings: AiProviderSettings;
  source: AiProviderSourceType;
}

// Update
export const UpdateAiProviderSchema = z.object({
  config: z.object({}).passthrough().optional(),
  description: z.string().nullish(),
  logo: z.string().nullish(),
  name: z.string(),
  sdkType: z.enum(AiProviderSdkTypes).optional(),
  settings: AiProviderSettingsSchema.optional(),
});

export type UpdateAiProviderParams = z.infer<typeof UpdateAiProviderSchema>;

export const UpdateAiProviderConfigSchema = z.object({
  checkModel: z.string().optional(),
  config: z
    .object({
      enableResponseApi: z.boolean().optional(),
    })
    .optional(),
  fetchOnClient: z.boolean().nullish(),
  keyVaults: z
    .record(
      z.string(),
      z.union([
        z.string().optional(),
        z.record(z.string(), z.string()).optional(), // Support nested objects, e.g. customHeaders
      ]),
    )
    .optional(),
});

export type UpdateAiProviderConfigParams = z.infer<typeof UpdateAiProviderConfigSchema>;

export interface AiProviderSortMap {
  id: string;
  sort: number;
}

// --------

export interface EnabledProvider {
  id: string;
  logo?: string;
  name?: string;
  source: AiProviderSourceType;
}

export interface EnabledProviderWithModels {
  children: AiModelForSelect[];
  id: string;
  logo?: string;
  name: string;
  source: AiProviderSourceType;
}

export interface AiProviderRuntimeConfig {
  config: AiProviderConfig;
  fetchOnClient?: boolean;
  keyVaults: Record<string, string>;
  settings: AiProviderSettings;
}

export interface BuiltinModelIdentifier {
  id: string;
  providerId: string;
}

export interface AiProviderRuntimeState {
  enabledAiModels: EnabledAiModel[];
  enabledAiProviders: EnabledProvider[];
  enabledChatAiProviders: EnabledProvider[];
  enabledImageAiProviders: EnabledProvider[];
  enabledVideoAiProviders: EnabledProvider[];
  hiddenBuiltinModels?: BuiltinModelIdentifier[];
  /** False when the server could not resolve the current user's hidden-model policy. */
  hiddenBuiltinModelsResolved?: boolean;
  /**
   * Retired `${providerId}/${modelId}` → successor model id (same provider).
   * Requests for a key are transparently served by its successor, so clients can
   * render "superseded by X" instead of "removed". Keys are provider-scoped so a
   * same-named model under an unrelated provider is never treated as redirected.
   */
  modelRedirects?: Record<string, string>;
  runtimeConfig: Record<string, AiProviderRuntimeConfig>;
}
