import { z } from 'zod';

import { isCredentialBearingUrl } from '../../security/redaction';
import {
  addConnectorToolListIssues,
  addConnectorToolSecurityIssues,
  CONNECTOR_TOOL_VALIDATION_CODES,
  connectorJsonObjectSchema,
  containsConnectorCredentialMaterial,
} from '../../services/connectorCatalog/toolDefinitionValidator';

export const connectorIdSchema = z.string().trim().min(1).max(128);
export const connectorKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export const connectorToolKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][\w.:/-]{0,199}$/u, CONNECTOR_TOOL_VALIDATION_CODES.invalidOperation);
export { containsConnectorCredentialMaterial };
export const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => !containsConnectorCredentialMaterial(value), 'secret material is not allowed');

export const publicTextSchema = z
  .string()
  .trim()
  .max(4000)
  .refine((value) => !containsConnectorCredentialMaterial(value), 'secret material is not allowed');
export const publicDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !containsConnectorCredentialMaterial(value), 'secret material is not allowed');
export const CONNECTOR_OPERATION_MESSAGE_BY_STATUS = {
  failure: 'connector.operation_failed',
  pending: 'connector.operation_pending',
  success: 'connector.operation_succeeded',
} as const;
export const connectorSafeMessageSchema = z.enum([
  CONNECTOR_OPERATION_MESSAGE_BY_STATUS.failure,
  CONNECTOR_OPERATION_MESSAGE_BY_STATUS.pending,
  CONNECTOR_OPERATION_MESSAGE_BY_STATUS.success,
]);

export const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .url()
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid HTTP(S) URL' });
      return;
    }
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

const containsControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || codePoint === 127;
  });

export const connectorReturnToSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    const normalized = normalizeReturnToForValidation(value);
    return (
      normalized.startsWith('/') &&
      !normalized.startsWith('//') &&
      !normalized.includes('\\') &&
      !containsControlCharacter(normalized)
    );
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
  'PLATFORM_CONNECTOR_CONFIRMATION_REQUIRED',
  'PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED',
  'PLATFORM_CONNECTOR_NOT_FOUND',
  'PLATFORM_CONNECTOR_NOT_PUBLISHED',
  'PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID',
  'PLATFORM_CONNECTOR_OAUTH_STATE_EXPIRED',
  'PLATFORM_CONNECTOR_OAUTH_STATE_INVALID',
  'PLATFORM_CONNECTOR_OAUTH_STATE_REPLAYED',
  'PLATFORM_CONNECTOR_RETURN_TO_INVALID',
  'PLATFORM_CONNECTOR_RATE_LIMITED',
  'PLATFORM_CONNECTOR_RESOURCE_MISMATCH',
  'PLATFORM_CONNECTOR_SCOPE_NOT_ALLOWED',
  'PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED',
  'PLATFORM_CONNECTOR_SSRF_BLOCKED',
  'PLATFORM_CONNECTOR_STDIO_UNSUPPORTED',
  'PLATFORM_CONNECTOR_TOOL_DENIED',
  'PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED',
]);

export type PlatformConnectorErrorCode = z.infer<typeof platformConnectorErrorCodeSchema>;

export class PlatformConnectorContractError extends Error {
  constructor(public readonly code: PlatformConnectorErrorCode) {
    super(code);
    this.name = 'PlatformConnectorContractError';
  }
}

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

export const connectorSharedCredentialSchema = z
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

export const emptyConnectorSecretStateSchema = z
  .object({ configured: z.literal(false), fingerprint: z.null(), updatedAt: z.null() })
  .strict();

export const adminConnectorOAuthConfigSchema = z
  .object({
    authorizationEndpoint: httpUrlSchema,
    clientId: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .refine(
        (value) => !containsConnectorCredentialMaterial(value),
        'secret material is not allowed',
      ),
    issuer: httpUrlSchema,
    redirectUri: httpUrlSchema,
    scopes: connectorScopesSchema,
    tokenEndpoint: httpUrlSchema,
  })
  .strict();

export const adminConnectorOAuthConfigInputSchema = adminConnectorOAuthConfigSchema.omit({
  redirectUri: true,
});

export const connectorToolDraftObjectSchema = z
  .object({
    description: z.string().trim().max(4000).nullable(),
    displayName: z.string().trim().min(1).max(200),
    enabled: z.boolean(),
    id: connectorIdSchema,
    inputSchema: connectorJsonObjectSchema,
    outputSchema: connectorJsonObjectSchema.default({}),
    platformPolicy: connectorPlatformToolPolicySchema,
    requiresConfirmation: z.boolean(),
    riskLevel: connectorRiskLevelSchema,
    sort: z.number().int(),
    toolKey: connectorToolKeySchema,
  })
  .strict();

export const connectorToolDraftSchema = connectorToolDraftObjectSchema.superRefine(
  addConnectorToolSecurityIssues,
);

export const publishedConnectorToolObjectSchema = connectorToolDraftObjectSchema
  .pick({
    description: true,
    displayName: true,
    inputSchema: true,
    outputSchema: true,
    platformPolicy: true,
    requiresConfirmation: true,
    riskLevel: true,
    sort: true,
    toolKey: true,
  })
  .strict();

export const publishedConnectorToolSchema = publishedConnectorToolObjectSchema.superRefine(
  addConnectorToolSecurityIssues,
);

export const connectorToolWithoutIdSchema = connectorToolDraftObjectSchema
  .omit({ id: true })
  .strict()
  .superRefine(addConnectorToolSecurityIssues);
export const connectorToolDraftListSchema = z
  .array(connectorToolDraftSchema)
  .max(1000, CONNECTOR_TOOL_VALIDATION_CODES.toolCount)
  .superRefine(addConnectorToolListIssues);
export const connectorToolWithoutIdListSchema = z
  .array(connectorToolWithoutIdSchema)
  .max(1000, CONNECTOR_TOOL_VALIDATION_CODES.toolCount)
  .superRefine(addConnectorToolListIssues);
export const publishedConnectorToolListSchema = z
  .array(publishedConnectorToolSchema)
  .max(1000, CONNECTOR_TOOL_VALIDATION_CODES.toolCount)
  .superRefine(addConnectorToolListIssues);

export const connectorConnectionTestStateSchema = z
  .object({
    errorCategory: z.enum(['auth', 'network', 'protocol', 'invalid_config', 'policy']).nullable(),
    latencyMs: z.number().int().nonnegative().nullable(),
    messageCode: connectorSafeMessageSchema,
    stale: z.boolean(),
    status: z.enum(['pending', 'success', 'failure']),
    testedAt: z.date(),
    testedDraftToken: z.string().length(64),
    testedRevision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.messageCode !== CONNECTOR_OPERATION_MESSAGE_BY_STATUS[value.status]) {
      ctx.addIssue({ code: 'custom', message: 'status and messageCode must match' });
    }
  });

export const connectorSha256Schema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
