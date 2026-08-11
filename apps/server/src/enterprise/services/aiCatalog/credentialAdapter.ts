import { ModelProvider } from 'model-bank';

import type {
  PlatformAiProviderConfig,
  PlatformAiProviderSettings,
} from '@/database/schemas/platform';
import {
  hasModelRuntimeEnvironmentFallback,
  resolveModelRuntimeProvider,
} from '@/server/modules/ModelRuntime';

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

/**
 * Providers that exist in ModelProvider but have no platform-managed credential lifecycle.
 * ChatGPT and SuperGrok are personal OAuth only (refresh tokens bound to a user); platform catalog cannot
 * store or refresh oauthAccessToken, and API-key credentials are not valid for them.
 */
const PLATFORM_UNSUPPORTED_RUNTIME_PROVIDERS = new Set<string>([
  ModelProvider.ChatGPT,
  ModelProvider.SuperGrok,
]);

export const resolveAiCatalogRuntimeProvider = (
  providerKey: string,
  settings: PlatformAiProviderSettings,
  source: string,
): string => resolveModelRuntimeProvider(providerKey, settings.sdkType, source);

const assertSupportedRuntimeProvider = (runtimeProvider: string): void => {
  if (PLATFORM_UNSUPPORTED_RUNTIME_PROVIDERS.has(runtimeProvider)) {
    throw new AiCatalogValidationError([
      `${runtimeProvider} is personal OAuth only and cannot be managed as a platform provider`,
    ]);
  }
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
  source: string,
): string => {
  const runtimeProvider = resolveAiCatalogRuntimeProvider(providerKey, settings, source);
  assertSupportedRuntimeProvider(runtimeProvider);
  return runtimeProvider;
};

const hasText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

type CredentialEnv = Record<string, string | undefined>;

export const hasAiCatalogEnvironmentFallback = (
  runtimeProvider: string,
  env: CredentialEnv = process.env,
): boolean => hasModelRuntimeEnvironmentFallback(runtimeProvider, env);

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
  source: string;
  settings: PlatformAiProviderSettings;
}) => {
  const runtimeProvider = resolveAiCatalogRuntimeProvider(
    params.providerKey,
    params.settings,
    params.source,
  );
  assertSupportedRuntimeProvider(runtimeProvider);
  const keyVaults: AiCatalogCredentialVault = { ...params.keyVaults };
  if (typeof params.config.endpoint === 'string') keyVaults.baseURL = params.config.endpoint;
  assertAllowedKeys(runtimeProvider, keyVaults);
  assertRequiredCredentials(runtimeProvider, keyVaults, params.env ?? process.env);
  return { keyVaults, runtimeProvider };
};

/**
 * Keys whose string values are actual secret material. Structural fields such as
 * `authType`, `region`, `apiVersion`, and public endpoints (`baseURL`) are excluded so
 * benign public catalog data (e.g. region labels, auth mode enums) is not treated as a
 * credential leaf for leakage checks.
 */
const SECRET_CREDENTIAL_STRING_KEYS = new Set([
  'accessKeyId',
  'apiKey',
  'bearerToken',
  'oauthAccessToken',
  'password',
  'secretAccessKey',
  'sessionToken',
]);

/**
 * Substring matching below this length collides with public tokens (regions, enums).
 * Short secrets from known secret keys are still extracted; callers must match them
 * with exact/token-aware rules ({@link credentialAppearsInPublicText}).
 */
export const MIN_CREDENTIAL_SUBSTRING_MATCH_LENGTH = 8;

/** Header names whose values are treated as secret material (case-insensitive). */
const SECRET_CUSTOM_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
]);

/**
 * Extract secret-bearing string leaves from a credential vault for public-field leakage checks.
 * - Known secret keys (`apiKey`, `password`, …) contribute every non-empty value, including short ones.
 * - Unstructured top-level strings always contribute (they are the secret itself).
 * - Custom headers contribute only secret-bearing header names, or sufficiently long values.
 */
export const credentialStringLeaves = (value: unknown): string[] => {
  const leaves: string[] = [];

  const push = (text: string) => {
    if (text) leaves.push(text);
  };

  const walk = (node: unknown, parentKey?: string): void => {
    if (typeof node === 'string') {
      if (!node) return;
      // Unstructured top-level secret, or a known secret-bearing field — never drop short secrets.
      if (parentKey === undefined || SECRET_CREDENTIAL_STRING_KEYS.has(parentKey)) {
        push(node);
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, parentKey);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'customHeaders' && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const [headerName, headerValue] of Object.entries(child as Record<string, unknown>)) {
          if (typeof headerValue !== 'string' || !headerValue) continue;
          const secretHeader = SECRET_CUSTOM_HEADER_NAMES.has(headerName.toLowerCase());
          // Authorization-like headers always; other long header values still screened.
          if (secretHeader || headerValue.length >= MIN_CREDENTIAL_SUBSTRING_MATCH_LENGTH) {
            push(headerValue);
          }
        }
        continue;
      }
      walk(child, key);
    }
  };

  walk(value);
  return leaves;
};

/**
 * True when a public-field string discloses a credential leaf.
 * Short secrets use exact equality or token boundaries so "us"/"east" style fragments
 * do not false-positive; longer secrets use substring inclusion (and entropy-style overlap).
 */
export const credentialAppearsInPublicText = (text: string, credential: string): boolean => {
  if (!credential || !text) return false;
  if (credential.length < MIN_CREDENTIAL_SUBSTRING_MATCH_LENGTH) {
    if (text === credential) return true;
    // Token-aware: whole-token match with non-alnum boundaries (or string edges).
    const escaped = credential.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^A-Za-z0-9_+/=-])${escaped}(?:$|[^A-Za-z0-9_+/=-])`).test(text);
  }
  return text.includes(credential);
};
