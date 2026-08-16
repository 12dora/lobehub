import { z } from 'zod';

import {
  PLATFORM_CONNECTOR_ERROR_CODE_VALUES,
  type PlatformConnectorErrorCode,
} from '@/const/platform/errorCodes';

import { isCredentialBearingUrl } from '../../security/redaction';
import {
  addConnectorToolListIssues,
  addConnectorToolSecurityIssues,
  CONNECTOR_TOOL_VALIDATION_CODES,
  connectorJsonObjectSchema,
  containsConnectorCredentialMaterial,
} from '../../services/connectorCatalog/toolDefinitionValidator';
import { httpHeaderNameSchema, httpHeaderValueSchema } from '../shared';

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

/**
 * Audit reason for connector operations the admin console no longer prompts for (save, test,
 * discover, publish, archive, create). Recorded when a caller supplies one.
 */
export const optionalReasonSchema = reasonSchema.optional();

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

export const platformConnectorErrorCodeSchema = z.enum(PLATFORM_CONNECTOR_ERROR_CODE_VALUES);

export type { PlatformConnectorErrorCode };

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

/** Max header entries on connector shared credentials (aligned with AI catalog). */
export const CONNECTOR_HEADER_MAP_MAX_ENTRIES = 50;

/** Write-time: RFC 9110 field-name tokens (reject-on-write). */
const connectorHeaderNameWriteSchema = httpHeaderNameSchema.max(200);

/**
 * Read-time header names: control-char-only rule used before the RFC token
 * grammar. Pre-token-rule vaults may store spaces, colons, or non-ASCII names.
 * Read paths must accept those so admins can `replace` a corrected map (detail
 * API is presence-only — secret values are not projected).
 */
const connectorHeaderNameReadSchema = z
  .string()
  .min(1)
  .max(200)
  // eslint-disable-next-line no-control-regex -- control-char class is the validation target
  .regex(/^[^\u0000-\u001F\u007F]+$/, 'header name must not contain control characters');

const connectorHeaderValueSchema = httpHeaderValueSchema.max(32_768);

const refineConnectorHeaderMapEntries = (
  value: Record<string, string>,
  ctx: z.RefinementCtx,
): void => {
  if (Object.keys(value).length > CONNECTOR_HEADER_MAP_MAX_ENTRIES) {
    ctx.addIssue({
      code: 'custom',
      message: `header map exceeds max entry count of ${CONNECTOR_HEADER_MAP_MAX_ENTRIES}`,
    });
  }
};

/** Write-time header map (RFC 9110 names). Used by secret mutations. */
const connectorHeaderMapWriteSchema = z
  .record(connectorHeaderNameWriteSchema, connectorHeaderValueSchema)
  .superRefine(refineConnectorHeaderMapEntries);

/** Read-time header map (legacy control-char-only names). Used by catalog/runtime parse. */
const connectorHeaderMapReadSchema = z
  .record(connectorHeaderNameReadSchema, connectorHeaderValueSchema)
  .superRefine(refineConnectorHeaderMapEntries);

/**
 * Write-time shared credential schema: RFC 9110 header-name tokens.
 * Used by secret mutations (`connectorSharedSecretMutationSchema`) and admin
 * connection-test input parsing. Admins repair legacy invalid names by
 * `replace` with a corrected `headers` map (detail API is presence-only).
 */
export const connectorSharedCredentialSchema = z
  .object({
    apiKey: z.string().min(1).max(32_768).optional(),
    bearerToken: z.string().min(1).max(32_768).optional(),
    headers: connectorHeaderMapWriteSchema.optional(),
    password: z.string().min(1).max(32_768).optional(),
    username: z.string().min(1).max(1000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'credential object must not be empty');

/**
 * Read-time shared credential schema: lenient header names for already-stored
 * secrets (accept-on-read / reject-on-write). Used by catalog snapshot,
 * readiness, and runtime resolution so pre-token-rule credentials do not
 * hard-fail every read with no repair path.
 */
export const connectorSharedCredentialReadSchema = z
  .object({
    apiKey: z.string().min(1).max(32_768).optional(),
    bearerToken: z.string().min(1).max(32_768).optional(),
    headers: connectorHeaderMapReadSchema.optional(),
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
