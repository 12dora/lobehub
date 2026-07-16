import { z } from 'zod';

import {
  containsSensitiveMaterial,
  isCredentialBearingUrl,
  isSensitiveKey,
} from '../security/redaction';

const connectorIdSchema = z.string().trim().min(1).max(128);
const connectorKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const connectorToolKeySchema = z.string().trim().min(1).max(200);
const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => !containsSensitiveMaterial(value), 'secret material is not allowed');

const validateNonSecretJson = (
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<number | string> = [],
): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateNonSecretJson(item, ctx, [...path, index]));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (
      typeof value === 'string' &&
      (containsSensitiveMaterial(value) || isCredentialBearingUrl(value))
    ) {
      ctx.addIssue({ code: 'custom', message: 'secret material is not allowed', path });
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      ctx.addIssue({
        code: 'custom',
        message: 'sensitive key is not allowed',
        path: [...path, key],
      });
      continue;
    }
    validateNonSecretJson(child, ctx, [...path, key]);
  }
};

const boundedNonSecretJsonSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  validateNonSecretJson(value, ctx);
  if (JSON.stringify(value).length > 64 * 1024) {
    ctx.addIssue({ code: 'custom', message: 'JSON payload is too large' });
  }
});

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'only HTTP(S) URLs are supported' });
    }
    if (isCredentialBearingUrl(value)) {
      ctx.addIssue({ code: 'custom', message: 'credential-bearing URL is not allowed' });
    }
  });

const normalizeReturnToForValidation = (value: string): string => {
  let current = value;
  for (let index = 0; index < value.length; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      return '';
    }
  }
  return current;
};

export const connectorReturnToSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    const normalized = normalizeReturnToForValidation(value);
    return normalized.startsWith('/') && !normalized.startsWith('//') && !normalized.includes('\\');
  }, 'returnTo must be a site-relative path');

export const connectorCredentialModeSchema = z.enum([
  'none',
  'shared_service_account',
  'per_user_oauth',
]);

/** Web runtime is HTTP-only. `stdio` is deliberately absent and therefore fails closed. */
export const webConnectorTransportSchema = z.literal('http');

export const connectorRiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export const connectorPlatformToolPolicySchema = z.enum(['allow', 'deny']);
export const connectorLifecycleStatusSchema = z.enum(['draft', 'published', 'archived']);
export const connectorBindingStatusSchema = z.enum([
  'disconnected',
  'pending',
  'connected',
  'expired',
  'revoked',
  'error',
]);

export const platformConnectorErrorCodeSchema = z.enum([
  'PLATFORM_CONNECTOR_BINDING_NOT_FOUND',
  'PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH',
  'PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED',
  'PLATFORM_CONNECTOR_NOT_FOUND',
  'PLATFORM_CONNECTOR_NOT_PUBLISHED',
  'PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID',
  'PLATFORM_CONNECTOR_OAUTH_STATE_EXPIRED',
  'PLATFORM_CONNECTOR_OAUTH_STATE_INVALID',
  'PLATFORM_CONNECTOR_OAUTH_STATE_REPLAYED',
  'PLATFORM_CONNECTOR_RETURN_TO_INVALID',
  'PLATFORM_CONNECTOR_SCOPE_NOT_ALLOWED',
  'PLATFORM_CONNECTOR_SSRF_BLOCKED',
  'PLATFORM_CONNECTOR_STDIO_UNSUPPORTED',
  'PLATFORM_CONNECTOR_TOOL_DENIED',
  'PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED',
]);

const connectorScopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/);

export const connectorScopesSchema = z
  .array(connectorScopeSchema)
  .max(50)
  .superRefine((scopes, ctx) => {
    if (new Set(scopes).size !== scopes.length) {
      ctx.addIssue({ code: 'custom', message: 'OAuth scopes must be unique' });
    }
  });

const connectorSharedCredentialSchema = z
  .object({
    apiKey: z.string().min(1).max(32_768).optional(),
    bearerToken: z.string().min(1).max(32_768).optional(),
    headers: z.record(z.string().min(1).max(200), z.string().min(1).max(32_768)).optional(),
    password: z.string().min(1).max(32_768).optional(),
    username: z.string().min(1).max(1000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'credential object must not be empty');

export const connectorSharedSecretMutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('keep') }).strict(),
  z.object({ operation: z.literal('replace'), value: connectorSharedCredentialSchema }).strict(),
  z.object({ operation: z.literal('clear') }).strict(),
]);

export const connectorOAuthClientSecretMutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('keep') }).strict(),
  z.object({ operation: z.literal('replace'), value: z.string().min(1).max(32_768) }).strict(),
  z.object({ operation: z.literal('clear') }).strict(),
]);

export const connectorSecretStateSchema = z
  .object({
    configured: z.boolean(),
    fingerprint: z.string().min(1).max(256).nullable(),
    updatedAt: z.date().nullable(),
  })
  .strict();

export const adminConnectorOAuthConfigSchema = z
  .object({
    authorizationEndpoint: httpUrlSchema,
    clientId: z.string().trim().min(1).max(1000),
    issuer: httpUrlSchema,
    redirectUri: httpUrlSchema,
    scopes: connectorScopesSchema,
    tokenEndpoint: httpUrlSchema,
  })
  .strict();

const adminConnectorOAuthConfigInputSchema = adminConnectorOAuthConfigSchema.omit({
  redirectUri: true,
});

export const connectorToolDraftSchema = z
  .object({
    description: z.string().trim().max(4000).nullable(),
    displayName: z.string().trim().min(1).max(200),
    enabled: z.boolean(),
    id: connectorIdSchema,
    inputSchema: boundedNonSecretJsonSchema,
    platformPolicy: connectorPlatformToolPolicySchema,
    requiresConfirmation: z.boolean(),
    riskLevel: connectorRiskLevelSchema,
    sort: z.number().int(),
    toolKey: connectorToolKeySchema,
  })
  .strict();

export const publishedConnectorToolSchema = connectorToolDraftSchema
  .pick({
    description: true,
    displayName: true,
    inputSchema: true,
    platformPolicy: true,
    requiresConfirmation: true,
    riskLevel: true,
    sort: true,
    toolKey: true,
  })
  .strict();

export const connectorConnectionTestStateSchema = z
  .object({
    errorCategory: z.enum(['auth', 'network', 'protocol', 'invalid_config', 'policy']).nullable(),
    latencyMs: z.number().int().nonnegative().nullable(),
    sanitizedMessage: z.string().max(500),
    stale: z.boolean(),
    status: z.enum(['pending', 'success', 'failure']),
    testedAt: z.date(),
    testedDraftToken: z.string().length(64),
    testedRevision: z.number().int().nonnegative(),
  })
  .strict();

export const adminConnectorDraftSchema = z
  .object({
    connectionTest: connectorConnectionTestStateSchema.nullable(),
    credentialMode: connectorCredentialModeSchema,
    description: z.string().trim().max(4000).nullable(),
    displayName: z.string().trim().min(1).max(200),
    enabled: z.boolean(),
    endpoint: httpUrlSchema,
    id: connectorIdSchema,
    key: connectorKeySchema,
    oauthClientSecret: connectorSecretStateSchema,
    oauthConfig: adminConnectorOAuthConfigSchema.nullable(),
    revision: z.number().int().nonnegative(),
    sharedSecret: connectorSecretStateSchema,
    sort: z.number().int(),
    status: connectorLifecycleStatusSchema,
    tools: z.array(connectorToolDraftSchema).max(1000),
    transport: webConnectorTransportSchema,
  })
  .strict();

export const adminPublishedConnectorSchema = adminConnectorDraftSchema
  .omit({ connectionTest: true, revision: true, status: true, tools: true })
  .extend({
    publishedAt: z.date(),
    publishedRevision: z.number().int().positive(),
    tools: z.array(publishedConnectorToolSchema).max(1000),
  })
  .strict();

const connectorDraftFieldsSchema = z
  .object({
    credentialMode: connectorCredentialModeSchema.optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    endpoint: httpUrlSchema.optional(),
    oauthClientSecret: connectorOAuthClientSecretMutationSchema.optional(),
    oauthConfig: adminConnectorOAuthConfigInputSchema.nullable().optional(),
    sharedSecret: connectorSharedSecretMutationSchema.optional(),
    sort: z.number().int().optional(),
    tools: z
      .array(connectorToolDraftSchema.omit({ id: true }))
      .max(1000)
      .optional(),
    transport: webConnectorTransportSchema.optional(),
  })
  .strict();

const validateConnectorCredentialFields = (
  value: z.infer<typeof connectorDraftFieldsSchema>,
  ctx: z.RefinementCtx,
): void => {
  if (value.credentialMode === 'none' && (value.sharedSecret || value.oauthClientSecret)) {
    ctx.addIssue({ code: 'custom', message: 'none credential mode cannot accept secrets' });
  }
  if (value.credentialMode === 'shared_service_account') {
    if (value.oauthConfig) {
      ctx.addIssue({
        code: 'custom',
        message: 'shared credential mode cannot accept OAuth config',
      });
    }
    if (value.oauthClientSecret) {
      ctx.addIssue({
        code: 'custom',
        message: 'shared credential mode cannot accept OAuth secret',
      });
    }
  }
  if (value.credentialMode === 'per_user_oauth' && value.sharedSecret) {
    ctx.addIssue({ code: 'custom', message: 'per-user OAuth cannot accept a shared secret' });
  }
};

export const adminConnectorListInputSchema = z
  .object({
    credentialMode: connectorCredentialModeSchema.optional(),
    cursor: connectorKeySchema.optional(),
    enabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    query: z.string().trim().min(1).max(200).optional(),
    status: connectorLifecycleStatusSchema.optional(),
  })
  .strict();

export const adminConnectorListOutputSchema = z
  .object({
    items: z.array(adminConnectorDraftSchema.omit({ tools: true })),
    nextCursor: connectorKeySchema.nullable(),
  })
  .strict();

export const adminConnectorGetInputSchema = z.object({ id: connectorIdSchema }).strict();
export const adminConnectorGetOutputSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    draft: adminConnectorDraftSchema,
    draftToken: z.string().length(64),
    published: adminPublishedConnectorSchema.nullable(),
  })
  .strict();

export const adminConnectorCreateDraftInputSchema = connectorDraftFieldsSchema
  .extend({
    credentialMode: connectorCredentialModeSchema,
    displayName: z.string().trim().min(1).max(200),
    endpoint: httpUrlSchema,
    key: connectorKeySchema,
    reason: reasonSchema,
    transport: webConnectorTransportSchema.default('http'),
  })
  .strict()
  .superRefine(validateConnectorCredentialFields);

export const adminConnectorUpdateDraftInputSchema = connectorDraftFieldsSchema
  .extend({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    id: connectorIdSchema,
    reason: reasonSchema,
  })
  .strict()
  .superRefine(validateConnectorCredentialFields);

const adminConnectorDraftActionInputSchema = z
  .object({ id: connectorIdSchema, reason: reasonSchema })
  .strict();

export const adminConnectorDiscoverInputSchema = adminConnectorDraftActionInputSchema;
export const adminConnectorTestInputSchema = adminConnectorDraftActionInputSchema;

export const adminConnectorDiscoverOutputSchema = z
  .object({
    oauthConfig: adminConnectorOAuthConfigSchema.nullable(),
    sanitizedMessage: z.string().max(500),
    tools: z.array(connectorToolDraftSchema.omit({ id: true })).max(1000),
  })
  .strict();

export const adminConnectorTestOutputSchema = connectorConnectionTestStateSchema.omit({
  stale: true,
  testedDraftToken: true,
  testedRevision: true,
});

const adminConnectorPublicationInputSchema = z
  .object({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    id: connectorIdSchema,
    reason: reasonSchema,
  })
  .strict();

export const adminConnectorPublishInputSchema = adminConnectorPublicationInputSchema;
export const adminConnectorRollbackInputSchema = adminConnectorPublicationInputSchema
  .extend({ targetRevision: z.number().int().positive() })
  .strict();
export const adminConnectorRevokeAllBindingsInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    id: connectorIdSchema,
    reason: reasonSchema,
  })
  .strict();

export const adminConnectorRevisionOutputSchema = z
  .object({ auditId: connectorIdSchema, revision: z.number().int().positive() })
  .strict();

export const connectorBindingSchema = z
  .object({
    connectedAt: z.date().nullable(),
    expiresAt: z.date().nullable(),
    id: connectorIdSchema,
    lastErrorCategory: z.enum(['auth', 'network', 'oauth', 'policy']).nullable(),
    scopes: connectorScopesSchema,
    status: connectorBindingStatusSchema,
    updatedAt: z.date(),
  })
  .strict();

export const managedConnectorToolSchema = publishedConnectorToolSchema
  .omit({ inputSchema: true, platformPolicy: true })
  .extend({ available: z.boolean() })
  .strict();

/** User projection intentionally omits endpoint, transport, OAuth client/config, and secret state. */
export const managedConnectorSchema = z
  .object({
    binding: connectorBindingSchema.nullable(),
    credentialMode: connectorCredentialModeSchema,
    description: z.string().trim().max(4000).nullable(),
    displayName: z.string().trim().min(1).max(200),
    id: connectorIdSchema,
    key: connectorKeySchema,
    publishedRevision: z.number().int().positive(),
    tools: z.array(managedConnectorToolSchema).max(1000),
  })
  .strict();

export const userConnectorListManagedInputSchema = z
  .object({
    cursor: connectorKeySchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    query: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const userConnectorListManagedOutputSchema = z
  .object({ items: z.array(managedConnectorSchema), nextCursor: connectorKeySchema.nullable() })
  .strict();

export const userConnectorStartAuthorizationInputSchema = z
  .object({ connectorId: connectorIdSchema, returnTo: connectorReturnToSchema.optional() })
  .strict();
export const userConnectorStartAuthorizationOutputSchema = z
  .object({ authorizationUrl: httpUrlSchema, bindingId: connectorIdSchema })
  .strict();

export const userConnectorGetAuthorizationStatusInputSchema = z
  .object({ connectorId: connectorIdSchema })
  .strict();
export const userConnectorGetAuthorizationStatusOutputSchema = z
  .object({ binding: connectorBindingSchema.nullable() })
  .strict();

export const userConnectorDisconnectInputSchema = z
  .object({ connectorId: connectorIdSchema })
  .strict();
export const userConnectorDisconnectOutputSchema = z
  .object({ disconnected: z.literal(true) })
  .strict();

/** Server-only state. Callback callers submit only `code` and opaque `state`. */
export const connectorOAuthStatePayloadSchema = z
  .object({
    bindingId: connectorIdSchema,
    codeChallengeMethod: z.literal('S256'),
    codeVerifier: z.string().min(43).max(128),
    connectorId: connectorIdSchema,
    expiresAt: z.number().int().positive(),
    issuedAt: z.number().int().positive(),
    publishedRevision: z.number().int().positive(),
    redirectUri: httpUrlSchema,
    returnTo: connectorReturnToSchema.optional(),
    scopes: connectorScopesSchema,
    userId: connectorIdSchema,
  })
  .strict()
  .refine((value) => value.expiresAt > value.issuedAt, 'OAuth state expiry must follow issuance');

export const connectorOAuthCallbackInputSchema = z
  .object({ code: z.string().trim().min(1).max(8192), state: z.string().trim().min(32).max(512) })
  .strict();

export const connectorEffectiveToolPolicyInputSchema = z
  .object({
    agentAllowed: z.boolean(),
    platformPolicy: connectorPlatformToolPolicySchema,
    userEnabled: z.boolean(),
  })
  .strict();

export const connectorEffectiveToolPolicyOutputSchema = z
  .object({ allowed: z.boolean(), deniedBy: z.enum(['platform', 'agent', 'user']).nullable() })
  .strict();
