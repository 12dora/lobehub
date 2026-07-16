import { ModelProvider } from 'model-bank';

import type {
  PlatformAiProviderConfig,
  PlatformAiProviderSettings,
} from '@/database/schemas/platform';

import { AiCatalogValidationError } from './errors';

export interface AiCatalogCredentialVault {
  [key: string]: Record<string, string> | string | undefined;
  customHeaders?: Record<string, string>;
}

const SPECIAL_KEYS: Partial<Record<string, Set<string>>> = {
  [ModelProvider.Azure]: new Set(['apiKey', 'apiVersion', 'baseURL']),
  [ModelProvider.Bedrock]: new Set([
    'accessKeyId',
    'apiKey',
    'region',
    'secretAccessKey',
    'sessionToken',
  ]),
  [ModelProvider.Cloudflare]: new Set(['apiKey', 'baseURLOrAccountID']),
  [ModelProvider.ComfyUI]: new Set([
    'apiKey',
    'authType',
    'baseURL',
    'customHeaders',
    'password',
    'username',
  ]),
  [ModelProvider.GithubCopilot]: new Set([
    'apiKey',
    'bearerToken',
    'bearerTokenExpiresAt',
    'oauthAccessToken',
  ]),
  [ModelProvider.Ollama]: new Set(['baseURL']),
  [ModelProvider.VertexAI]: new Set(['apiKey', 'baseURL', 'region']),
};

const OPENAI_COMPATIBLE_KEYS = new Set(['apiKey', 'baseURL']);
const SUPPORTED_RUNTIME_PROVIDERS = new Set<string>(Object.values(ModelProvider));

export const resolveAiCatalogRuntimeProvider = (
  providerKey: string,
  settings: PlatformAiProviderSettings,
): string =>
  settings.sdkType ??
  (SUPPORTED_RUNTIME_PROVIDERS.has(providerKey) ? providerKey : ModelProvider.OpenAI);

const assertSupportedRuntimeProvider = (runtimeProvider: string): void => {
  if (!SUPPORTED_RUNTIME_PROVIDERS.has(runtimeProvider)) {
    throw new AiCatalogValidationError(['Unsupported provider runtime']);
  }
};

const assertAllowedKeys = (runtimeProvider: string, keyVaults: AiCatalogCredentialVault): void => {
  const allowed = SPECIAL_KEYS[runtimeProvider] ?? OPENAI_COMPATIBLE_KEYS;
  const invalid = Object.keys(keyVaults).filter((key) => !allowed.has(key));
  if (invalid.length > 0) {
    throw new AiCatalogValidationError(['Credential fields do not match provider runtime']);
  }
};

export const validateAiCatalogCredentialShape = (
  runtimeProvider: string,
  keyVaults: AiCatalogCredentialVault,
): void => {
  assertSupportedRuntimeProvider(runtimeProvider);
  assertAllowedKeys(runtimeProvider, keyVaults);
};

export const validateAiCatalogRuntimeProvider = (
  providerKey: string,
  settings: PlatformAiProviderSettings,
): string => {
  const runtimeProvider = resolveAiCatalogRuntimeProvider(providerKey, settings);
  assertSupportedRuntimeProvider(runtimeProvider);
  return runtimeProvider;
};

const hasText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

type CredentialEnv = Record<string, string | undefined>;

export const hasAiCatalogEnvironmentFallback = (
  runtimeProvider: string,
  env: CredentialEnv = process.env,
): boolean => {
  switch (runtimeProvider) {
    case ModelProvider.Bedrock: {
      return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION);
    }
    case ModelProvider.Azure: {
      return Boolean(env.AZURE_API_KEY && env.AZURE_ENDPOINT);
    }
    case ModelProvider.Cloudflare: {
      return Boolean(env.CLOUDFLARE_API_KEY && env.CLOUDFLARE_BASE_URL_OR_ACCOUNT_ID);
    }
    case ModelProvider.ComfyUI: {
      return Boolean(env.COMFYUI_BASE_URL);
    }
    case ModelProvider.Ollama: {
      return Boolean(env.OLLAMA_PROXY_URL);
    }
    case ModelProvider.VertexAI: {
      return Boolean(env.VERTEXAI_CREDENTIALS && env.VERTEXAI_PROJECT);
    }
    default: {
      const envPrefix = runtimeProvider.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_');
      return Boolean(env[`${envPrefix}_API_KEY`]);
    }
  }
};

const assertRequiredCredentials = (
  runtimeProvider: string,
  keyVaults: AiCatalogCredentialVault,
  env: CredentialEnv,
): void => {
  if (hasAiCatalogEnvironmentFallback(runtimeProvider, env)) return;
  switch (runtimeProvider) {
    case ModelProvider.Ollama: {
      if (!hasText(keyVaults.baseURL)) {
        throw new AiCatalogValidationError(['Ollama requires an explicit platform endpoint']);
      }
      return;
    }
    case ModelProvider.Bedrock: {
      const accessPair = hasText(keyVaults.accessKeyId) && hasText(keyVaults.secretAccessKey);
      if ((!accessPair && !hasText(keyVaults.apiKey)) || !hasText(keyVaults.region)) {
        throw new AiCatalogValidationError(['Bedrock credentials are incomplete']);
      }
      return;
    }
    case ModelProvider.Cloudflare: {
      if (!hasText(keyVaults.apiKey) || !hasText(keyVaults.baseURLOrAccountID)) {
        throw new AiCatalogValidationError(['Cloudflare credentials are incomplete']);
      }
      return;
    }
    case ModelProvider.ComfyUI: {
      if (!hasText(keyVaults.baseURL)) {
        throw new AiCatalogValidationError(['ComfyUI requires an explicit platform endpoint']);
      }
      const authType = keyVaults.authType ?? 'none';
      if (authType === 'basic' && (!hasText(keyVaults.username) || !hasText(keyVaults.password))) {
        throw new AiCatalogValidationError(['ComfyUI basic credentials are incomplete']);
      }
      if (authType === 'bearer' && !hasText(keyVaults.apiKey)) {
        throw new AiCatalogValidationError(['ComfyUI bearer credential is missing']);
      }
      if (
        authType === 'custom' &&
        (!keyVaults.customHeaders || Object.keys(keyVaults.customHeaders).length === 0)
      ) {
        throw new AiCatalogValidationError(['ComfyUI custom headers are missing']);
      }
      return;
    }
    case ModelProvider.GithubCopilot: {
      if (
        !hasText(keyVaults.apiKey) &&
        !hasText(keyVaults.bearerToken) &&
        !hasText(keyVaults.oauthAccessToken)
      ) {
        throw new AiCatalogValidationError(['GitHub Copilot credential is missing']);
      }
      return;
    }
    case ModelProvider.VertexAI: {
      if (!hasText(keyVaults.apiKey)) {
        throw new AiCatalogValidationError(['Vertex AI service account is missing']);
      }
      try {
        const credentials: unknown = JSON.parse(keyVaults.apiKey);
        if (
          !credentials ||
          typeof credentials !== 'object' ||
          !('client_email' in credentials) ||
          !('private_key' in credentials) ||
          !('project_id' in credentials)
        ) {
          throw new Error('invalid service account');
        }
      } catch {
        throw new AiCatalogValidationError(['Vertex AI service account is invalid']);
      }
      return;
    }
    default: {
      if (!hasText(keyVaults.apiKey)) {
        throw new AiCatalogValidationError(['Provider API key is missing']);
      }
    }
  }
};

export const normalizeAiCatalogExecutionCredentials = (params: {
  config: PlatformAiProviderConfig;
  env?: CredentialEnv;
  keyVaults: AiCatalogCredentialVault;
  providerKey: string;
  settings: PlatformAiProviderSettings;
}) => {
  const runtimeProvider = resolveAiCatalogRuntimeProvider(params.providerKey, params.settings);
  assertSupportedRuntimeProvider(runtimeProvider);
  const keyVaults: AiCatalogCredentialVault = { ...params.keyVaults };
  if (typeof params.config.endpoint === 'string') keyVaults.baseURL = params.config.endpoint;
  assertAllowedKeys(runtimeProvider, keyVaults);
  assertRequiredCredentials(runtimeProvider, keyVaults, params.env ?? process.env);
  return { keyVaults, runtimeProvider };
};

export const credentialStringLeaves = (value: unknown): string[] => {
  if (typeof value === 'string') return value ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(credentialStringLeaves);
};
