import { ModelProvider } from 'model-bank';

import type {
  PlatformAiProviderConfig,
  PlatformAiProviderSettings,
} from '@/database/schemas/platform';
import {
  hasModelRuntimeEnvironmentFallback,
  resolveModelRuntimeProvider,
} from '@/server/modules/ModelRuntime';
import { OAUTH_RENEWAL_KINDS, parseOAuthRenewalKind } from '@/server/services/oauthDeviceFlow';

import type { CredentialEnv } from './credentialRequirements';
import { requireApiKey, REQUIRED_CREDENTIALS } from './credentialRequirements';
import { AiCatalogValidationError } from './errors';

export interface AiCatalogCredentialVault {
  [key: string]: Record<string, string> | string | undefined;
  customHeaders?: Record<string, string>;
}

/**
 * Non-secret refresh bookkeeping every rotating-refresh OAuth vault carries: the keepalive
 * anchor and the post-failure backoff anchor (both epoch ms, stored as strings because the
 * platform vault only holds string leaves). See `oauthDeviceFlow/refresh.ts`.
 *
 * Plus the reauth marker (`oauthGrantInvalidAt` epoch ms + `oauthGrantInvalidReason`, a stable
 * code from `sharedOAuthReauthMarker.ts`): written when the credential is TERMINALLY rejected —
 * by the renewal or by a real execution — and cleared by the next successful renewal or
 * reconnect, so the admin card can say 需要重新授权 instead of reporting a dead account as
 * healthy. Non-secret, like the stamps above.
 */
const REFRESH_LIFECYCLE_KEYS = [
  'oauthGrantInvalidAt',
  'oauthGrantInvalidReason',
  'oauthLastRefreshAt',
  'oauthLastRefreshErrorAt',
] as const;

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
  [ModelProvider.ChatGPT]: new Set([
    'oauthAccessToken',
    // Display-only account identity — intentionally absent from SECRET_CREDENTIAL_STRING_KEYS.
    'oauthAccountEmail',
    'oauthAccountId',
    // Refresh-lifecycle bookkeeping (epoch ms as strings), written only by the server-side
    // refresh pipeline. Non-secret, but they live in the vault because the whole credential
    // moves as one encrypted blob — and they MUST be listed here, or the first admin
    // credential merge after a rotation would be rejected as an unknown key.
    ...REFRESH_LIFECYCLE_KEYS,
    'oauthRefreshToken',
    'oauthTokenExpiresAt',
  ]),
  [ModelProvider.ChatGPTWeb]: new Set([
    'oauthAccessToken',
    // Display-only account identity — intentionally absent from SECRET_CREDENTIAL_STRING_KEYS.
    'oauthAccountEmail',
    'oauthAccountId',
    // Stable `oai-device-id` for the sentinel handshake; non-secret, but it must not change.
    'oauthDeviceId',
    ...REFRESH_LIFECYCLE_KEYS,
    // Optional: the access-token paste fallback has no refresh grant at all.
    'oauthRefreshToken',
    /**
     * Which credential `oauthRefreshToken` holds — `'oauth'` (PKCE refresh token) or
     * `'web_session'` (the chatgpt.com session cookie, which mints access tokens the way
     * the web app does). Non-secret by design, like the refresh-lifecycle stamps: it is a
     * label the refresh path dispatches on, and the admin status view names it.
     */
    'oauthRenewalKind',
    'oauthTokenExpiresAt',
  ]),
  [ModelProvider.GithubCopilot]: new Set([
    'apiKey',
    'bearerToken',
    'bearerTokenExpiresAt',
    'oauthAccessToken',
  ]),
  [ModelProvider.Ollama]: new Set(['baseURL']),
  [ModelProvider.Grok]: new Set([
    'oauthAccessToken',
    // Display-only account identity — intentionally absent from SECRET_CREDENTIAL_STRING_KEYS.
    'oauthAccountEmail',
    'oauthAccountId',
    ...REFRESH_LIFECYCLE_KEYS,
    'oauthRefreshToken',
    'oauthTokenExpiresAt',
  ]),
  [ModelProvider.Cursor]: new Set([
    'oauthAccessToken',
    // Display-only account identity — intentionally absent from SECRET_CREDENTIAL_STRING_KEYS.
    'oauthAccountEmail',
    'oauthAccountId',
    ...REFRESH_LIFECYCLE_KEYS,
    'oauthRefreshToken',
    'oauthRenewalKind',
    'oauthTokenExpiresAt',
  ]),
  [ModelProvider.SuperGrok]: new Set([
    'oauthAccessToken',
    // Display-only account identity — intentionally absent from SECRET_CREDENTIAL_STRING_KEYS.
    'oauthAccountEmail',
    'oauthAccountId',
    ...REFRESH_LIFECYCLE_KEYS,
    'oauthRefreshToken',
    'oauthTokenExpiresAt',
  ]),
  [ModelProvider.VertexAI]: new Set(['apiKey', 'baseURL', 'region']),
};

const OPENAI_COMPATIBLE_KEYS = new Set(['apiKey', 'baseURL']);

/**
 * Credential shape of a provider, as a capability set.
 *
 * Callers that used to branch on `providerKey === ModelProvider.ChatGPT` to decide which
 * identity leaves to store ask this instead: whether a leaf may be persisted is a
 * property of the credential SHAPE (unknown keys are hard-rejected downstream), never of
 * a hard-coded provider id.
 */
export const providerCredentialKeys = (runtimeProvider: string): ReadonlySet<string> =>
  SPECIAL_KEYS[runtimeProvider] ?? OPENAI_COMPATIBLE_KEYS;
const SUPPORTED_RUNTIME_PROVIDERS = new Set<string>(Object.values(ModelProvider));

export const resolveAiCatalogRuntimeProvider = (
  providerKey: string,
  settings: PlatformAiProviderSettings,
  source: string,
): string => resolveModelRuntimeProvider(providerKey, settings.sdkType, source);

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

/**
 * `oauthRenewalKind` decides HOW the renewal credential is spent — at the OAuth token
 * endpoint, or as a chatgpt.com session cookie — so a value nothing recognises, or one
 * standing next to no credential at all, is a connection that renews itself the wrong way (or
 * claims a renewal path it does not have).
 *
 * Enforced on the WRITE path only. Durable state written by older code is deliberately
 * tolerated on the read side, where an unrecognised label falls back to identifying the
 * credential by shape (see `parseOAuthRenewalKind`) — rejecting it there would take a working
 * connection down over a label.
 */
const assertRenewalKindShape = (keyVaults: AiCatalogCredentialVault): void => {
  const kind = keyVaults.oauthRenewalKind;
  if (kind === undefined) return;
  if (!parseOAuthRenewalKind(kind)) {
    throw new AiCatalogValidationError([
      `Unsupported OAuth renewal kind (expected one of: ${OAUTH_RENEWAL_KINDS.join(', ')})`,
    ]);
  }
  // The label describes `oauthRefreshToken`; the two are written and cleared as a UNIT by
  // every connect path, and a lone label would outlive the credential it names.
  if (typeof keyVaults.oauthRefreshToken !== 'string' || !keyVaults.oauthRefreshToken) {
    throw new AiCatalogValidationError(['OAuth renewal kind must accompany a renewal credential']);
  }
};

export const validateAiCatalogCredentialShape = (
  runtimeProvider: string,
  keyVaults: AiCatalogCredentialVault,
): void => {
  assertSupportedRuntimeProvider(runtimeProvider);
  assertAllowedKeys(runtimeProvider, keyVaults);
  assertRenewalKindShape(keyVaults);
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
  (REQUIRED_CREDENTIALS[runtimeProvider] ?? requireApiKey)(keyVaults);
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
  'oauthRefreshToken',
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
