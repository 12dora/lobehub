import '@/server/globalConfig';

import { type GoogleGenAIOptions } from '@google/genai';
import {
  mergeModelRuntimeHooks,
  ModelRuntime,
  type ModelRuntimeHooks,
} from '@lobechat/model-runtime';
import { LobeVertexAI } from '@lobechat/model-runtime/vertexai';
import {
  type AWSBedrockKeyVault,
  type AzureOpenAIKeyVault,
  type ClientSecretPayload,
  type CloudflareKeyVault,
  type ComfyUIKeyVault,
  type GithubCopilotKeyVault,
  type OAuthDeviceFlowKeyVault,
  type OpenAICompatibleKeyVault,
  type SuperGrokKeyVault,
  type VertexAIKeyVault,
} from '@lobechat/types';
import { safeParseJSON } from '@lobechat/utils';
import { ModelProvider } from 'model-bank';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

import { getBusinessModelRuntimeHooks } from '@/business/server/model-runtime';
import type { EgressScopeId } from '@/const/platform/networkProxy';
import { providerEgressScope } from '@/const/platform/networkProxy';
import { AiProviderModel } from '@/database/models/aiProvider';
import { type LobeChatDatabase } from '@/database/type';
import { getLLMConfig } from '@/envs/llm';
import { isBootModuleEnabled } from '@/server/enterprise/services/moduleSettings';
import { bindNetworkProxyEgressIfEnabled } from '@/server/enterprise/services/networkProxy/engine/bindEgress';
import {
  createPlatformAiAuthFailureHooks,
  createPlatformAiModelAllowlistHooks,
  digestPlatformAiCredential,
  isPlatformManagedAiEnabled,
  type PlatformAiExactModelRef,
  resolvePlatformAiExecutionConfig,
  resolvePlatformAiExecutionConfigAtRevision,
  wrapPlatformModelRuntime,
} from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';
import { createLLMGenerationTracingHook } from '@/server/services/llmGenerationTracing/hook';
import { ensureFreshOAuthToken } from '@/server/services/oauthDeviceFlow/refresh';

import { KeyVaultsGateKeeper } from '../KeyVaultsEncrypt';
import apiKeyManager from './apiKeyManager';

export * from './trace';

/**
 * Combined KeyVaults type for all providers
 */
type ProviderKeyVaults = OpenAICompatibleKeyVault &
  AzureOpenAIKeyVault &
  AWSBedrockKeyVault &
  CloudflareKeyVault &
  ComfyUIKeyVault &
  GithubCopilotKeyVault &
  OAuthDeviceFlowKeyVault &
  SuperGrokKeyVault &
  VertexAIKeyVault;

/**
 * Resolve the runtime provider for a given provider.
 *
 * This is the server-side equivalent of the frontend's resolveRuntimeProvider function.
 * For builtin providers, returns the provider as-is.
 * For custom providers, returns the sdkType from settings (defaults to 'openai').
 *
 * @param provider - The provider id
 * @param sdkType - The sdkType from provider settings
 * @returns The resolved runtime provider
 */
export const resolveModelRuntimeProvider = (
  provider: string,
  sdkType?: string,
  source?: string,
): string => {
  const isBuiltin = source
    ? source === 'builtin'
    : Object.values(ModelProvider).includes(provider as ModelProvider);
  if (isBuiltin) return provider;

  return sdkType || ModelProvider.OpenAI;
};

type ModelRuntimeEnvironment = Record<string, string | undefined>;

/** Mirrors the environment branches consumed by getParamsFromPayload/buildVertexOptions. */
export const hasModelRuntimeEnvironmentFallback = (
  provider: string,
  env: ModelRuntimeEnvironment = process.env,
): boolean => {
  switch (provider) {
    case ModelProvider.Azure: {
      return Boolean(env.AZURE_API_KEY && env.AZURE_ENDPOINT);
    }
    case ModelProvider.AzureAI: {
      return Boolean(env.AZUREAI_ENDPOINT_KEY && env.AZUREAI_ENDPOINT);
    }
    case ModelProvider.Bedrock: {
      return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION);
    }
    case ModelProvider.Cloudflare: {
      return Boolean(env.CLOUDFLARE_API_KEY && env.CLOUDFLARE_BASE_URL_OR_ACCOUNT_ID);
    }
    case ModelProvider.ComfyUI: {
      return Boolean(env.COMFYUI_BASE_URL);
    }
    case ModelProvider.GiteeAI: {
      return Boolean(env.GITEE_AI_API_KEY);
    }
    case ModelProvider.Github: {
      return Boolean(env.GITHUB_TOKEN);
    }
    // Subscription OAuth providers are personal-only; API-key env vars never make them ready.
    case ModelProvider.GithubCopilot:
    case ModelProvider.ChatGPT:
    case ModelProvider.ChatGPTWeb:
    case ModelProvider.LobeHub:
    case ModelProvider.SuperGrok: {
      return false;
    }
    case ModelProvider.Ollama: {
      return Boolean(env.OLLAMA_PROXY_URL);
    }
    case ModelProvider.OllamaCloud: {
      return Boolean(env.OLLAMA_CLOUD_API_KEY);
    }
    case ModelProvider.TencentCloud: {
      return Boolean(env.TENCENT_CLOUD_API_KEY);
    }
    case ModelProvider.VertexAI: {
      return Boolean(env.VERTEXAI_CREDENTIALS && env.VERTEXAI_PROJECT);
    }
    default: {
      const envPrefix = provider.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_');
      return Boolean(env[`${envPrefix}_API_KEY`]);
    }
  }
};

/**
 * Build ClientSecretPayload from keyVaults stored in database
 *
 * This is the server-side equivalent of the frontend's getProviderAuthPayload function.
 * It converts the keyVaults object from database to the ClientSecretPayload format
 * expected by initModelRuntimeWithUserPayload.
 *
 * For custom providers, we use runtimeProvider (sdkType) to determine which fields
 * to include in the payload. This ensures that provider-specific fields like
 * cloudflareBaseURLOrAccountID are correctly forwarded.
 *
 * @param keyVaults - The keyVaults object from database (already decrypted)
 * @param runtimeProvider - The runtime provider (sdkType) to use for building payload
 * @returns ClientSecretPayload for the provider
 */
export const buildPayloadFromKeyVaults = (
  keyVaults: ProviderKeyVaults,
  runtimeProvider: string,
): ClientSecretPayload => {
  // Use runtimeProvider to determine which fields to include
  // This handles both builtin providers and custom providers with sdkType
  switch (runtimeProvider) {
    case ModelProvider.Bedrock: {
      const { accessKeyId, apiKey, region, secretAccessKey, sessionToken } = keyVaults;

      return {
        apiKey,
        awsAccessKeyId: accessKeyId,
        awsRegion: region,
        awsSecretAccessKey: secretAccessKey,
        awsSessionToken: sessionToken,
        runtimeProvider,
      };
    }

    case ModelProvider.ChatGPT: {
      return {
        apiKey: keyVaults.oauthAccessToken,
        chatgptAccountId: keyVaults.oauthAccountId,
        runtimeProvider,
      };
    }

    case ModelProvider.ChatGPTWeb: {
      // The chatgpt.com web backend also needs a STABLE device id: the sentinel
      // handshake binds its proof-of-work token to `oai-device-id`.
      return {
        apiKey: keyVaults.oauthAccessToken,
        chatgptAccountId: keyVaults.oauthAccountId,
        chatgptDeviceId: keyVaults.oauthDeviceId,
        runtimeProvider,
      };
    }

    case ModelProvider.Azure:
    case ModelProvider.AzureAI: {
      return {
        apiKey: keyVaults.apiKey,
        baseURL: keyVaults.baseURL || keyVaults.endpoint,
        runtimeProvider,
      };
    }

    case ModelProvider.Ollama: {
      return { baseURL: keyVaults.baseURL, runtimeProvider };
    }

    case ModelProvider.Cloudflare: {
      return {
        apiKey: keyVaults.apiKey,
        cloudflareBaseURLOrAccountID: keyVaults.baseURLOrAccountID,
        runtimeProvider,
      };
    }

    case ModelProvider.ComfyUI: {
      return {
        apiKey: keyVaults.apiKey,
        authType: keyVaults.authType,
        baseURL: keyVaults.baseURL,
        customHeaders: keyVaults.customHeaders,
        password: keyVaults.password,
        runtimeProvider,
        username: keyVaults.username,
      };
    }

    case ModelProvider.VertexAI: {
      return {
        apiKey: keyVaults.apiKey,
        baseURL: keyVaults.baseURL,
        runtimeProvider,
        vertexAIRegion: keyVaults.region,
      };
    }

    case ModelProvider.GithubCopilot: {
      // Support both traditional PAT (apiKey) and OAuth tokens
      return {
        apiKey: keyVaults.apiKey,
        bearerToken: keyVaults.bearerToken,
        bearerTokenExpiresAt: keyVaults.bearerTokenExpiresAt
          ? Number(keyVaults.bearerTokenExpiresAt)
          : undefined,
        oauthAccessToken: keyVaults.oauthAccessToken,
        runtimeProvider,
      };
    }

    case ModelProvider.SuperGrok: {
      // OAuth-only provider: the (already refreshed) access token IS the
      // bearer credential for api.x.ai — expose it as apiKey so the runtime
      // stays a stateless OpenAI-compatible client.
      return {
        apiKey: keyVaults.oauthAccessToken,
        runtimeProvider,
      };
    }

    default: {
      return {
        apiKey: keyVaults.apiKey,
        baseURL: keyVaults.baseURL,
        runtimeProvider,
      };
    }
  }
};

/**
 * Retrieves the options object from environment and apikeymanager
 * based on the provider and payload.
 *
 * @param provider - The model provider.
 * @param payload - The JWT payload.
 * @returns The options object.
 */
const getParamsFromPayload = (provider: string, payload: ClientSecretPayload) => {
  const llmConfig = getLLMConfig() as Record<string, any>;

  switch (provider) {
    case ModelProvider.LobeHub: {
      return { apikey: payload.apiKey, baseURL: payload.baseURL, ...payload };
    }

    case ModelProvider.VertexAI: {
      return {};
    }

    default: {
      let upperProvider = provider.toUpperCase();

      if (!(`${upperProvider}_API_KEY` in llmConfig)) {
        upperProvider = ModelProvider.OpenAI.toUpperCase(); // Use OpenAI options as default
      }

      const apiKey = apiKeyManager.pick(payload?.apiKey || llmConfig[`${upperProvider}_API_KEY`]);
      const baseURL = payload?.baseURL || process.env[`${upperProvider}_PROXY_URL`];

      return baseURL ? { apiKey, baseURL } : { apiKey };
    }

    case ModelProvider.Ollama: {
      const baseURL = payload?.baseURL || process.env.OLLAMA_PROXY_URL;

      return { baseURL };
    }

    case ModelProvider.Azure: {
      const { AZURE_API_KEY, AZURE_ENDPOINT } = llmConfig;
      const apiKey = apiKeyManager.pick(payload?.apiKey || AZURE_API_KEY);
      const baseURL = payload?.baseURL || AZURE_ENDPOINT;
      return { apiKey, baseURL };
    }

    case ModelProvider.AzureAI: {
      const { AZUREAI_ENDPOINT, AZUREAI_ENDPOINT_KEY } = llmConfig;
      const apiKey = payload?.apiKey || AZUREAI_ENDPOINT_KEY;
      const baseURL = payload?.baseURL || AZUREAI_ENDPOINT;
      return { apiKey, baseURL };
    }

    case ModelProvider.Bedrock: {
      const { AWS_SECRET_ACCESS_KEY, AWS_ACCESS_KEY_ID, AWS_REGION, AWS_SESSION_TOKEN } = llmConfig;

      const hasUserBedrockAuth = !!(
        payload.apiKey ||
        payload.awsAccessKeyId ||
        payload.awsSecretAccessKey
      );

      if (hasUserBedrockAuth) {
        return {
          accessKeyId: payload.awsAccessKeyId,
          accessKeySecret: payload.awsSecretAccessKey,
          apiKey: apiKeyManager.pick(payload.apiKey),
          region: payload.awsRegion || AWS_REGION,
          sessionToken: payload.awsSessionToken,
        };
      }

      const accessKeyId: string | undefined = AWS_ACCESS_KEY_ID;
      const accessKeySecret: string | undefined = AWS_SECRET_ACCESS_KEY;
      const region = payload.awsRegion || AWS_REGION;
      const sessionToken: string | undefined = payload.awsSessionToken || AWS_SESSION_TOKEN;

      return { accessKeyId, accessKeySecret, region, sessionToken };
    }

    case ModelProvider.Cloudflare: {
      const { CLOUDFLARE_API_KEY, CLOUDFLARE_BASE_URL_OR_ACCOUNT_ID } = llmConfig;

      const apiKey = apiKeyManager.pick(payload?.apiKey || CLOUDFLARE_API_KEY);
      const baseURLOrAccountID =
        payload.apiKey && payload.cloudflareBaseURLOrAccountID
          ? payload.cloudflareBaseURLOrAccountID
          : CLOUDFLARE_BASE_URL_OR_ACCOUNT_ID;

      return { apiKey, baseURLOrAccountID };
    }

    case ModelProvider.GithubCopilot: {
      // Support both traditional PAT (apiKey) and OAuth tokens
      return {
        apiKey: payload.apiKey,
        bearerToken: payload.bearerToken,
        bearerTokenExpiresAt: payload.bearerTokenExpiresAt,
        oauthAccessToken: payload.oauthAccessToken,
      };
    }

    case ModelProvider.SuperGrok: {
      // OAuth-only: never fall back to env API keys
      return { apiKey: payload.apiKey };
    }

    case ModelProvider.ChatGPT: {
      // OAuth-only: never fall back to env API keys
      return {
        apiKey: payload.apiKey,
        chatgptAccountId: payload.chatgptAccountId,
      };
    }

    case ModelProvider.ChatGPTWeb: {
      // OAuth-only: never fall back to env API keys
      return {
        apiKey: payload.apiKey,
        chatgptAccountId: payload.chatgptAccountId,
        chatgptDeviceId: payload.chatgptDeviceId,
      };
    }

    case ModelProvider.ComfyUI: {
      const {
        COMFYUI_BASE_URL,
        COMFYUI_AUTH_TYPE,
        COMFYUI_API_KEY,
        COMFYUI_USERNAME,
        COMFYUI_PASSWORD,
        COMFYUI_CUSTOM_HEADERS,
      } = llmConfig;

      // ComfyUI specific handling with environment variables fallback
      const baseURL = payload?.baseURL || COMFYUI_BASE_URL || 'http://127.0.0.1:8000';

      // ComfyUI supports multiple auth types: none, basic, bearer, custom
      // Extract all relevant auth fields from the payload or environment
      const authType = payload?.authType || COMFYUI_AUTH_TYPE || 'none';
      const apiKey = payload?.apiKey || COMFYUI_API_KEY;
      const username = payload?.username || COMFYUI_USERNAME;
      const password = payload?.password || COMFYUI_PASSWORD;

      // Parse customHeaders from JSON string (similar to Vertex AI credentials handling)
      // Support both payload object and environment variable JSON string
      const customHeaders = payload?.customHeaders || safeParseJSON(COMFYUI_CUSTOM_HEADERS);

      // Return all authentication parameters
      return {
        apiKey,
        authType,
        baseURL,
        customHeaders,
        password,
        username,
      };
    }

    case ModelProvider.GiteeAI: {
      const { GITEE_AI_API_KEY } = llmConfig;

      const apiKey = apiKeyManager.pick(payload?.apiKey || GITEE_AI_API_KEY);

      return { apiKey };
    }

    case ModelProvider.Github: {
      const { GITHUB_TOKEN } = llmConfig;

      const apiKey = apiKeyManager.pick(payload?.apiKey || GITHUB_TOKEN);

      return { apiKey };
    }

    case ModelProvider.OllamaCloud: {
      const { OLLAMA_CLOUD_API_KEY } = llmConfig;

      const apiKey = apiKeyManager.pick(payload?.apiKey || OLLAMA_CLOUD_API_KEY);

      return { apiKey };
    }

    case ModelProvider.TencentCloud: {
      const { TENCENT_CLOUD_API_KEY } = llmConfig;

      const apiKey = apiKeyManager.pick(payload?.apiKey || TENCENT_CLOUD_API_KEY);

      return { apiKey };
    }
  }
};

const buildVertexOptions = (
  payload: ClientSecretPayload,
  params: Partial<GoogleGenAIOptions> = {},
): GoogleGenAIOptions => {
  const rawCredentials = payload.apiKey || process.env.VERTEXAI_CREDENTIALS || '';
  const credentials = safeParseJSON<Record<string, string>>(rawCredentials);

  const projectFromParams = params.project as string | undefined;
  const projectFromCredentials = credentials?.project_id;
  const projectFromEnv = process.env.VERTEXAI_PROJECT;

  const project = projectFromParams || projectFromCredentials || projectFromEnv;
  const location =
    (params.location as string | undefined) ||
    payload.vertexAIRegion ||
    process.env.VERTEXAI_LOCATION ||
    undefined;

  const googleAuthOptions = params.googleAuthOptions || (credentials ? { credentials } : undefined);

  const options: GoogleGenAIOptions = {
    ...params,
    vertexai: true,
  };

  if (googleAuthOptions) options.googleAuthOptions = googleAuthOptions;
  if (project) options.project = project;
  if (location) options.location = location as GoogleGenAIOptions['location'];

  return options;
};

/**
 * Initializes the agent runtime with the user payload in backend
 * @param provider - The provider name.
 * @param payload - The JWT payload.
 * @param params
 * @returns A promise that resolves when the agent runtime is initialized.
 */
/**
 * `undefined` for every other provider, so the runtime keeps its own default transport.
 * Never throws: a deployment without the binary must still build every other runtime,
 * and the ChatGPT Web failure surfaces on the first request instead.
 */
/**
 * OSS-safe reader for the enterprise egress hook. The binding is installed by
 * `services/networkProxy/egress/scope.ts` via
 * `Symbol.for('aihub.networkProxy.egressBinding')` so this file does not import
 * enterprise code (path-boundary).
 */
const EGRESS_BINDING = Symbol.for('aihub.networkProxy.egressBinding');

interface ModelRuntimeEgressHook {
  createEgressFetch: (scope: EgressScopeId) => typeof fetch;
  getEgressProxyUrlForCurl: (scope: EgressScopeId, target: string) => Promise<string | null>;
  recordProxiedConnectFailure?: (proxyUrl: string, error?: unknown) => void;
  recordProxiedConnectSuccess?: (proxyUrl: string) => void;
  wrapRuntimeWithEgressScope: <T extends object>(runtime: T, scope: EgressScopeId) => T;
}

const getEgressHook = (): ModelRuntimeEgressHook | undefined =>
  (globalThis as typeof globalThis & { [EGRESS_BINDING]?: ModelRuntimeEgressHook })[EGRESS_BINDING];

const extractFetchUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
};

/**
 * ChatGPT Web is the one runtime whose transport is not optional: chatgpt.com is behind
 * Cloudflare bot-fight and answers Node's own fetch with a 403 challenge whatever
 * headers are sent, because the TLS/HTTP2 fingerprint is what gets checked.
 *
 * The curl-impersonate factory is keyed by the current outlet `proxyUrl` so a
 * settings change does not leak credentials across transports. Decision is per call.
 */
const resolveChatGPTWebTransport = (
  runtimeProvider: string,
  scope: EgressScopeId,
): typeof fetch | undefined => {
  if (runtimeProvider !== ModelProvider.ChatGPTWeb) return undefined;
  return (async (input, init) => {
    const hook = getEgressHook();
    // Throws NetworkProxyUnavailableError on fail-mode — do not coerce to direct.
    const proxyUrl = hook
      ? await hook.getEgressProxyUrlForCurl(scope, extractFetchUrl(input))
      : null;
    try {
      const { getChatGPTWebFetch } =
        await import('@/server/enterprise/services/chatgptWeb/transport');
      const response = await getChatGPTWebFetch(proxyUrl)(input, init);
      // Proxied 2xx / 3xx / 4xx (≠ 407) clear prior connect-phase failures.
      // 407 is a CONNECT / proxy-auth failure, not a successful hop.
      if (proxyUrl && response.status !== 407) {
        hook?.recordProxiedConnectSuccess?.(proxyUrl);
      } else if (proxyUrl && response.status === 407) {
        hook?.recordProxiedConnectFailure?.(
          proxyUrl,
          Object.assign(new Error('Proxy authentication required'), { status: 407 }),
        );
      }
      return response;
    } catch (error) {
      if (proxyUrl) hook?.recordProxiedConnectFailure?.(proxyUrl, error);
      throw error;
    }
  }) as typeof fetch;
};

export type ModelRuntimeInitParams = {
  fetch?: typeof fetch;
  requestHandler?: unknown;
  userId?: string;
  // Allow provider-specific construction fields without losing transport options.
  [key: string]: unknown;
};

export const initModelRuntimeWithUserPayload = (
  provider: string,
  payload: ClientSecretPayload,
  params: ModelRuntimeInitParams = {},
  hooks?: ModelRuntimeHooks,
) => {
  const runtimeProvider = payload.runtimeProvider ?? provider;
  const { fetch: paramsFetch, requestHandler, ...restParams } = params;
  if (isBootModuleEnabled('networkProxy')) {
    bindNetworkProxyEgressIfEnabled();
  }
  /**
   * Egress scope key is the *catalog / caller provider id*, not the SDK
   * `runtimeProvider`. Platform custom providers use their directory id;
   * user-private custom providers are absent from config → off.
   *
   * Composition: `paramsFetch` (when present) stays the constructor-level
   * SSRF / probe adapter. The runtime is ALWAYS wrapped with
   * `wrapRuntimeWithEgressScope`, so bare `fetch()` inside methods is
   * ALS-bound to `createEgressFetch`. Connection probes additionally
   * compose egress into their SafeOutbound client (see connectionTestService).
   */
  const scope = providerEgressScope(provider);
  const hook = getEgressHook();
  const customFetch =
    paramsFetch ??
    resolveChatGPTWebTransport(runtimeProvider, scope) ??
    hook?.createEgressFetch(scope);

  const wrap = <T extends object>(runtime: T): T =>
    hook ? hook.wrapRuntimeWithEgressScope(runtime, scope) : runtime;

  if (runtimeProvider === ModelProvider.VertexAI) {
    const vertexOptions = buildVertexOptions(payload, restParams as never);
    const runtime = LobeVertexAI.initFromVertexAI({
      ...vertexOptions,
      ...(customFetch ? { fetch: customFetch } : {}),
    });

    return wrap(new ModelRuntime(runtime, hooks));
  }

  return wrap(
    ModelRuntime.initializeWithProvider(
      runtimeProvider,
      {
        ...getParamsFromPayload(runtimeProvider, payload),
        ...restParams,
        ...(customFetch ? { fetch: customFetch } : {}),
        ...(requestHandler ? { requestHandler: requestHandler as never } : {}),
      } as never,
      hooks,
    ),
  );
};

/**
 * Initialize ModelRuntime by reading user's provider configuration from database
 *
 * This function replaces the pattern of passing userPayload from frontend.
 * It reads the user's AI provider configuration from the database, decrypts
 * the keyVaults, and initializes the ModelRuntime.
 *
 * @param db - The database instance
 * @param userId - The user ID
 * @param provider - The model provider (e.g., 'openai', 'azure')
 * @returns Promise<ModelRuntime> - The initialized ModelRuntime instance
 *
 * @example
 * ```typescript
 * const modelRuntime = await initModelRuntimeFromDB(db, userId, 'openai');
 * const response = await modelRuntime.chat({ messages, model });
 * ```
 */
const isPlatformNotFoundError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'PLATFORM_NOT_FOUND') return true;
  return error instanceof Error && error.message === 'PLATFORM_NOT_FOUND';
};

/**
 * Map managed `enableResponseApi` to chat transport mode.
 * Explicit true → Responses API; explicit false → Chat Completions; unset → SDK default.
 * Shared by managed runtime init and connection probes so validation matches production.
 */
export const resolveManagedChatApiMode = (
  enableResponseApi: unknown,
): 'chatCompletion' | 'responses' | undefined => {
  if (enableResponseApi === true) return 'responses';
  if (enableResponseApi === false) return 'chatCompletion';
  return undefined;
};

/**
 * Inject published request-format into chat payloads when the caller has not already set apiMode.
 * Only attaches a hook when the catalog config is an explicit boolean.
 */
export const createManagedRequestModeHooks = (
  enableResponseApi: unknown,
): ModelRuntimeHooks | undefined => {
  const apiMode = resolveManagedChatApiMode(enableResponseApi);
  if (!apiMode) return undefined;
  return {
    beforeChat: async (payload) => {
      if (payload.apiMode === undefined) {
        payload.apiMode = apiMode;
      }
    },
  };
};

/**
 * User-owned (BYOK / self-built) provider path: reads the user's AiProvider row +
 * keyVaults. Never attaches platform allowlist hooks or platform secrets.
 */
const initUserModelRuntimeFromDB = async (
  db: LobeChatDatabase,
  userId: string,
  provider: string,
  workspaceId?: string,
): Promise<ModelRuntime> => {
  // 1. Get user's provider configuration from database
  const aiProviderModel = new AiProviderModel(db, userId, workspaceId);

  // Use getAiProviderById with KeyVaultsGateKeeper.getUserKeyVaults as decryptor
  const providerConfig = await aiProviderModel.getAiProviderById(
    provider,
    KeyVaultsGateKeeper.getUserKeyVaults,
  );

  // 2. Resolve the runtime provider for custom providers
  // For custom providers, use sdkType from settings (defaults to 'openai')
  const sdkType = providerConfig?.settings?.sdkType;
  const runtimeProvider = resolveModelRuntimeProvider(provider, sdkType);

  // 3. Build ClientSecretPayload from keyVaults based on runtimeProvider
  // This ensures provider-specific fields (e.g., cloudflareBaseURLOrAccountID) are included
  let keyVaults = (providerConfig?.keyVaults || {}) as ProviderKeyVaults;

  // 3.5. OAuth device-flow providers with rotating refresh tokens (e.g.
  // ChatGPT and SuperGrok): proactively refresh + persist the token pair before building
  // the payload. Mounted here because every server-side LLM call path (webapi
  // chat, agent runtime transport, async image/video, lambda routers)
  // converges on this function.
  const oauthDeviceFlowConfig = DEFAULT_MODEL_PROVIDER_LIST.find((p) => p.id === provider)?.settings
    ?.oauthDeviceFlow;
  if (oauthDeviceFlowConfig?.refreshTokenGrant) {
    const freshKeyVaults = await ensureFreshOAuthToken({
      config: oauthDeviceFlowConfig,
      db,
      keyVaults,
      providerId: provider,
      userId,
      workspaceId,
    });
    keyVaults = { ...keyVaults, ...freshKeyVaults } as ProviderKeyVaults;
  }

  const payload = buildPayloadFromKeyVaults(keyVaults, runtimeProvider);

  // 4. Get business hooks (billing in cloud, undefined in OSS)
  const businessHooks = getBusinessModelRuntimeHooks(userId, provider, workspaceId);

  // 5. Compose with the per-call llm_generation_tracing hook (no-op when the
  //    service is unconfigured, so OSS / self-hosted setups pay nothing for it).
  const tracingHooks = createLLMGenerationTracingHook(userId, provider, workspaceId);
  const hooks = mergeModelRuntimeHooks(businessHooks, tracingHooks);

  // 6. Initialize ModelRuntime with the payload and hooks
  // Note: providerConfig.config (e.g. enableResponseApi) is returned by getAiProviderById
  // and remains available to callers that read runtime state elsewhere; this path does not
  // strip config — payload/hooks construction only consumes keyVaults + sdkType (pre-existing).
  return initModelRuntimeWithUserPayload(provider, payload, { userId }, hooks);
};

export const initModelRuntimeFromDB = async (
  db: LobeChatDatabase,
  userId: string,
  provider: string,
  workspaceId?: string,
  options?: { skipModeration?: boolean },
): Promise<ModelRuntime> => {
  const wrap = (runtime: ModelRuntime) =>
    wrapPlatformModelRuntime(runtime, {
      db,
      provider,
      skipModeration: options?.skipModeration,
      userId,
      workspaceId,
    });

  if (isPlatformManagedAiEnabled()) {
    try {
      const providerConfig = await resolvePlatformAiExecutionConfig(db, provider);
      const runtimeProvider = providerConfig.runtimeProvider;
      const payload = buildPayloadFromKeyVaults(
        providerConfig.keyVaults as ProviderKeyVaults,
        runtimeProvider,
      );
      const businessHooks = getBusinessModelRuntimeHooks(userId, provider, workspaceId);
      const tracingHooks = createLLMGenerationTracingHook(userId, provider, workspaceId);
      const requestModeHooks = createManagedRequestModeHooks(
        providerConfig.config?.enableResponseApi,
      );
      /**
       * Platform credentials are shared: a rejection on THIS call is the only place the
       * platform learns that a stored (still unexpired) token stopped being accepted. The
       * digest pins the observation to the credential this runtime is built with, so a
       * reconnect between here and the 401 cannot make the new one look dead.
       */
      const authFailureHooks = createPlatformAiAuthFailureHooks(
        db,
        provider,
        digestPlatformAiCredential(providerConfig.keyVaults.oauthAccessToken as string | undefined),
      );
      const hooks = mergeModelRuntimeHooks(
        createPlatformAiModelAllowlistHooks(providerConfig.allowedModels),
        mergeModelRuntimeHooks(
          requestModeHooks,
          mergeModelRuntimeHooks(
            authFailureHooks,
            mergeModelRuntimeHooks(businessHooks, tracingHooks),
          ),
        ),
      );
      return wrap(await initModelRuntimeWithUserPayload(provider, payload, { userId }, hooks));
    } catch (error) {
      // Platform catalog governs platform providers only. User self-built / BYOK providers
      // are absent from the catalog → fall back to the user's own config. Other platform
      // errors (secrets, allowlist, etc.) still fail closed.
      if (!isPlatformNotFoundError(error)) throw error;
    }
  }

  return wrap(await initUserModelRuntimeFromDB(db, userId, provider, workspaceId));
};

/**
 * Initialize a ModelRuntime bound to an EXACT historical published provider revision (MODEL-EXACT).
 *
 * Used only for a managed platform operation carrying a pinned model ref, so an in-flight operation
 * keeps running on the provider revision it started on even after the admin publishes a newer
 * revision. Resolves the exact revision config + credentials fail-closed (missing / disabled /
 * checksum-mismatch throws), composes the same published-model allowlist + business/tracing hooks as
 * the managed path, and never reads the current/latest pointer. Requires managed AI to be enabled
 * (the caller only reaches this for a platform pin); credentials are decrypted per-execution and
 * never persisted.
 */
export const initPlatformExactModelRuntime = async (
  db: LobeChatDatabase,
  userId: string,
  ref: PlatformAiExactModelRef,
  workspaceId?: string,
): Promise<ModelRuntime> => {
  const providerConfig = await resolvePlatformAiExecutionConfigAtRevision(db, ref);
  const payload = buildPayloadFromKeyVaults(
    providerConfig.keyVaults as ProviderKeyVaults,
    providerConfig.runtimeProvider,
  );
  const businessHooks = getBusinessModelRuntimeHooks(userId, ref.providerKey, workspaceId);
  const tracingHooks = createLLMGenerationTracingHook(userId, ref.providerKey, workspaceId);
  const requestModeHooks = createManagedRequestModeHooks(providerConfig.config?.enableResponseApi);
  /**
   * Pinned to the credential of THIS historical revision: an operation still running on an old
   * revision must never report the current one as dead (the digests simply will not match).
   */
  const authFailureHooks = createPlatformAiAuthFailureHooks(
    db,
    ref.providerKey,
    digestPlatformAiCredential(providerConfig.keyVaults.oauthAccessToken as string | undefined),
  );
  const hooks = mergeModelRuntimeHooks(
    createPlatformAiModelAllowlistHooks(providerConfig.allowedModels),
    mergeModelRuntimeHooks(
      requestModeHooks,
      mergeModelRuntimeHooks(authFailureHooks, mergeModelRuntimeHooks(businessHooks, tracingHooks)),
    ),
  );
  return wrapPlatformModelRuntime(
    await initModelRuntimeWithUserPayload(ref.providerKey, payload, { userId }, hooks),
    { db, provider: ref.providerKey, userId, workspaceId },
  );
};
