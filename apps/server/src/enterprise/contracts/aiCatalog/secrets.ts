import { z } from 'zod';

import { boundedHeaderMapSchema } from './headers';

export const aiConnectionTestStateSchema = z
  .object({
    errorCategory: z
      .enum(['auth', 'network', 'rate_limit', 'provider', 'invalid_config'])
      .nullable(),
    latencyMs: z.number().int().nonnegative().nullable(),
    sanitizedMessage: z.string().max(500),
    stale: z.boolean(),
    status: z.enum(['pending', 'success', 'failure']),
    testedAt: z.date(),
    testedDraftToken: z.string().length(64),
    testedRevision: z.number().int().nonnegative(),
  })
  .strict();

const aiStructuredCredentialSchema = z
  .object({
    accessKeyId: z.string().min(1).max(32_768).optional(),
    apiKey: z.string().min(1).max(32_768).optional(),
    apiVersion: z.string().min(1).max(200).optional(),
    authType: z.enum(['none', 'basic', 'bearer', 'custom']).optional(),
    baseURL: z.string().min(1).max(4000).optional(),
    baseURLOrAccountID: z.string().min(1).max(4000).optional(),
    bearerToken: z.string().min(1).max(32_768).optional(),
    bearerTokenExpiresAt: z.string().min(1).max(200).optional(),
    customHeaders: boundedHeaderMapSchema.optional(),
    oauthAccessToken: z.string().min(1).max(32_768).optional(),
    /**
     * Display-only identity of a shared OAuth account (OIDC `email`, else
     * `preferred_username`). Not validated as an email — some providers return a username.
     * Deliberately NOT a secret leaf: it is projected to admins by `getConnectionStatus`.
     */
    oauthAccountEmail: z.string().min(1).max(320).optional(),
    oauthAccountId: z.string().min(1).max(200).optional(),
    oauthRefreshToken: z.string().min(1).max(32_768).optional(),
    /** Epoch millis as a string — the platform secret vault only stores string leaves. */
    oauthTokenExpiresAt: z.string().min(1).max(200).optional(),
    password: z.string().min(1).max(32_768).optional(),
    region: z.string().min(1).max(200).optional(),
    secretAccessKey: z.string().min(1).max(32_768).optional(),
    sessionToken: z.string().min(1).max(32_768).optional(),
    username: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'credential object must not be empty');

export const aiSecretMutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('keep') }).strict(),
  z
    .object({
      operation: z.literal('replace'),
      value: z.union([z.string().min(1).max(32_768), aiStructuredCredentialSchema]),
    })
    .strict(),
  /**
   * Overlay non-empty credential fields onto the existing vault.
   * Empty strings are ignored and unsubmitted fields are retained, so `unset` is the ONLY
   * way a merge can remove a leaf. Needed when a group of leaves must move as a unit — a
   * shared-OAuth reconnect that returns no email must not leave the previous account's
   * email sitting next to the new credential.
   */
  z
    .object({
      operation: z.literal('merge'),
      unset: z.array(z.string().min(1).max(64)).max(20).optional(),
      value: z.union([z.string().min(1).max(32_768), aiStructuredCredentialSchema]),
    })
    .strict(),
  z.object({ operation: z.literal('clear') }).strict(),
]);

/** Client-facing secret presence only — fingerprint stays server-internal (never projected). */
export const aiSecretStateSchema = z
  .object({
    configured: z.boolean(),
    updatedAt: z.date().nullable(),
  })
  .strict();

/**
 * Stable runtime error codes the connection test may surface. Deliberately an allowlist, not
 * `z.string()`: the probe must never echo provider-authored text (a message can carry request
 * material), and an operator-facing hint may only be keyed off a code we recognise.
 * Values are `AgentRuntimeErrorType` members plus the platform catalog's own code.
 */
export const AI_CONNECTION_TEST_ERROR_TYPES = [
  'AccountDeactivated',
  'AgentRuntimeError',
  // The ChatGPT Web transport binary (curl-impersonate) is not installed on this host.
  'CHATGPT_WEB_TRANSPORT_UNAVAILABLE',
  // The Cursor Agent CLI (`cursor-agent`) is not installed on this host.
  'cli_unavailable',
  'ConnectionCheckFailed',
  'ExceededContextWindow',
  'InsufficientQuota',
  'InvalidBedrockCredentials',
  'InvalidProviderAPIKey',
  'InvalidRequestFormat',
  'InvalidVertexCredentials',
  'ModelNotFound',
  'NoAvailableProvider',
  'OAuthAuthorizationExpired',
  'PermissionDenied',
  'PLATFORM_AI_MODEL_NOT_PUBLISHED',
  'ProviderBizError',
  'ProviderNetworkError',
  'QuotaLimitReached',
  'RateLimitExceeded',
  'UserConfigError',
] as const;

export type AiConnectionTestErrorType = (typeof AI_CONNECTION_TEST_ERROR_TYPES)[number];

export const aiConnectionTestResultSchema = z
  .object({
    errorCategory: z
      .enum(['auth', 'network', 'rate_limit', 'provider', 'invalid_config'])
      .nullable(),
    /** Present only when the runtime reported a code from the allowlist above. */
    errorType: z.enum(AI_CONNECTION_TEST_ERROR_TYPES).optional(),
    latencyMs: z.number().int().nonnegative(),
    sanitizedMessage: z.string().max(500),
    status: z.enum(['success', 'failure']),
    testedAt: z.date(),
  })
  .strict();
