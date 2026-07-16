import { z } from 'zod';

import { isCredentialBearingUrl } from '../security/redaction';
import {
  addConnectorToolListIssues,
  addConnectorToolSecurityIssues,
  CONNECTOR_TOOL_VALIDATION_CODES,
  connectorJsonObjectSchema,
  containsConnectorCredentialMaterial,
} from '../services/connectorCatalog/toolDefinitionValidator';

const connectorIdSchema = z.string().trim().min(1).max(128);
const connectorKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const connectorToolKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][\w.:/-]{0,199}$/u, CONNECTOR_TOOL_VALIDATION_CODES.invalidOperation);
export { containsConnectorCredentialMaterial };
const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => !containsConnectorCredentialMaterial(value), 'secret material is not allowed');

const publicTextSchema = z
  .string()
  .trim()
  .max(4000)
  .refine((value) => !containsConnectorCredentialMaterial(value), 'secret material is not allowed');
const publicDisplayNameSchema = z
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

const httpUrlSchema = z
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

const emptyConnectorSecretStateSchema = z
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

const adminConnectorOAuthConfigInputSchema = adminConnectorOAuthConfigSchema.omit({
  redirectUri: true,
});

const connectorToolDraftObjectSchema = z
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

const publishedConnectorToolObjectSchema = connectorToolDraftObjectSchema
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

const connectorToolWithoutIdSchema = connectorToolDraftObjectSchema
  .omit({ id: true })
  .strict()
  .superRefine(addConnectorToolSecurityIssues);
const connectorToolDraftListSchema = z
  .array(connectorToolDraftSchema)
  .max(1000, CONNECTOR_TOOL_VALIDATION_CODES.toolCount)
  .superRefine(addConnectorToolListIssues);
const connectorToolWithoutIdListSchema = z
  .array(connectorToolWithoutIdSchema)
  .max(1000, CONNECTOR_TOOL_VALIDATION_CODES.toolCount)
  .superRefine(addConnectorToolListIssues);
const publishedConnectorToolListSchema = z
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

const adminConnectorDraftBaseSchema = z
  .object({
    connectionTest: connectorConnectionTestStateSchema.nullable(),
    description: publicTextSchema.nullable(),
    displayName: publicDisplayNameSchema,
    enabled: z.boolean(),
    endpoint: httpUrlSchema,
    id: connectorIdSchema,
    key: connectorKeySchema,
    revision: z.number().int().nonnegative(),
    sort: z.number().int(),
    status: connectorLifecycleStatusSchema,
    tools: connectorToolDraftListSchema,
    transport: webConnectorTransportSchema,
  })
  .strict();

const adminConnectorNoneDraftSchema = adminConnectorDraftBaseSchema
  .extend({
    credentialMode: z.literal('none'),
    oauthClientSecret: emptyConnectorSecretStateSchema,
    oauthConfig: z.null(),
    sharedSecret: emptyConnectorSecretStateSchema,
  })
  .strict();
const adminConnectorSharedDraftSchema = adminConnectorDraftBaseSchema
  .extend({
    credentialMode: z.literal('shared_service_account'),
    oauthClientSecret: emptyConnectorSecretStateSchema,
    oauthConfig: z.null(),
    sharedSecret: connectorSecretStateSchema,
  })
  .strict();
const adminConnectorOAuthDraftSchema = adminConnectorDraftBaseSchema
  .extend({
    credentialMode: z.literal('per_user_oauth'),
    oauthClientSecret: connectorSecretStateSchema,
    oauthConfig: adminConnectorOAuthConfigSchema,
    sharedSecret: emptyConnectorSecretStateSchema,
  })
  .strict();

export const adminConnectorDraftSchema = z.discriminatedUnion('credentialMode', [
  adminConnectorNoneDraftSchema,
  adminConnectorSharedDraftSchema,
  adminConnectorOAuthDraftSchema,
]);

const publishedConnectorFields = {
  publishedAt: z.date(),
  publishedRevision: z.number().int().positive(),
  tools: publishedConnectorToolListSchema,
};

export const adminPublishedConnectorSchema = z.discriminatedUnion('credentialMode', [
  adminConnectorNoneDraftSchema
    .omit({ connectionTest: true, revision: true, status: true, tools: true })
    .extend(publishedConnectorFields)
    .strict(),
  adminConnectorSharedDraftSchema
    .omit({ connectionTest: true, revision: true, status: true, tools: true })
    .extend(publishedConnectorFields)
    .strict(),
  adminConnectorOAuthDraftSchema
    .omit({ connectionTest: true, revision: true, status: true, tools: true })
    .extend(publishedConnectorFields)
    .strict(),
]);

const adminConnectorListItemSchema = z.discriminatedUnion('credentialMode', [
  adminConnectorNoneDraftSchema.omit({ tools: true }),
  adminConnectorSharedDraftSchema.omit({ tools: true }),
  adminConnectorOAuthDraftSchema.omit({ tools: true }),
]);

const connectorDraftFieldsSchema = z
  .object({
    credentialMode: connectorCredentialModeSchema.optional(),
    description: publicTextSchema.nullable().optional(),
    displayName: publicDisplayNameSchema.optional(),
    enabled: z.boolean().optional(),
    endpoint: httpUrlSchema.optional(),
    oauthClientSecret: connectorOAuthClientSecretMutationSchema.optional(),
    oauthConfig: adminConnectorOAuthConfigInputSchema.nullable().optional(),
    sharedSecret: connectorSharedSecretMutationSchema.optional(),
    sort: z.number().int().optional(),
    tools: connectorToolDraftListSchema.optional(),
    transport: webConnectorTransportSchema.optional(),
  })
  .strict();

const connectorCreateBaseSchema = z
  .object({
    description: publicTextSchema.nullable().optional(),
    displayName: publicDisplayNameSchema,
    enabled: z.boolean().optional(),
    endpoint: httpUrlSchema,
    key: connectorKeySchema,
    reason: reasonSchema,
    sort: z.number().int().optional(),
    tools: connectorToolWithoutIdListSchema.optional(),
    transport: webConnectorTransportSchema.default('http'),
  })
  .strict();

export const adminConnectorCreateDraftInputSchema = z.discriminatedUnion('credentialMode', [
  connectorCreateBaseSchema.extend({ credentialMode: z.literal('none') }).strict(),
  connectorCreateBaseSchema
    .extend({
      credentialMode: z.literal('shared_service_account'),
      sharedSecret: connectorSharedSecretMutationSchema.optional(),
    })
    .strict(),
  connectorCreateBaseSchema
    .extend({
      credentialMode: z.literal('per_user_oauth'),
      oauthClientSecret: connectorOAuthClientSecretMutationSchema.optional(),
      oauthConfig: adminConnectorOAuthConfigInputSchema,
    })
    .strict(),
]);

export const adminConnectorUpdateDraftInputSchema = connectorDraftFieldsSchema
  .extend({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    id: connectorIdSchema,
    reason: reasonSchema,
  })
  .strict();

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
    items: z.array(adminConnectorListItemSchema),
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

const clearSecretMutation = { operation: 'clear' } as const;
const emptySecretState = { configured: false, fingerprint: null, updatedAt: null } as const;
const configuredSecretState = { configured: true, fingerprint: null, updatedAt: null } as const;
const clearOnlySecretMutationSchema = z.object({ operation: z.literal('clear') }).strict();
const connectorSecretSlotLeavesSchema = z
  .object({
    oauthClientSecret: z.array(z.string().min(1).max(32_768)).max(1000),
    sharedSecret: z.array(z.string().min(1).max(32_768)).max(1000),
  })
  .strict();

export interface ConnectorSecretSlotSources {
  oauthClientSecret?: unknown;
  sharedSecret?: unknown;
}

export interface ConnectorCurrentSecretLoader {
  loadCurrentSecretSources: (connectorId: string) => Promise<ConnectorSecretSlotSources>;
}

export interface TrustedConnectorSecretContext {
  readonly source: 'server-secret-store';
}

const trustedSecretContexts = new WeakMap<
  TrustedConnectorSecretContext,
  {
    connectorId: string;
    current: z.infer<typeof connectorSecretSlotLeavesSchema>;
    replacement: z.infer<typeof connectorSecretSlotLeavesSchema>;
  }
>();

const KNOWN_SECRET_STRUCTURE_KEYS = new Set([
  'accesstoken',
  'apikey',
  'bearertoken',
  'clientsecret',
  'oauthaccesstoken',
  'password',
  'refreshtoken',
  'secretaccesskey',
  'sessiontoken',
  'username',
]);
const DYNAMIC_SECRET_CONTAINER_KEYS = new Set(['customheaders', 'headers']);
const normalizeSecretStructureKey = (key: string): string =>
  key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');

const collectSecretLeafValues = (
  value: unknown,
  output: Set<string>,
  dynamicKeys = false,
): void => {
  if (typeof value === 'string') {
    if (value.length > 0) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectSecretLeafValues(item, output, dynamicKeys));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, item]) => {
    const normalizedKey = normalizeSecretStructureKey(key);
    const childHasDynamicKeys = DYNAMIC_SECRET_CONTAINER_KEYS.has(normalizedKey);
    if (dynamicKeys || (!KNOWN_SECRET_STRUCTURE_KEYS.has(normalizedKey) && !childHasDynamicKeys)) {
      collectSecretLeafValues(key, output, true);
    }
    collectSecretLeafValues(item, output, dynamicKeys || childHasDynamicKeys);
  });
};

/** Canonical schema-aware collector shared by contracts and services. */
export const collectConnectorSecretLeaves = (...secretSources: unknown[]): Set<string> => {
  const leaves = new Set<string>();
  secretSources.forEach((source) => collectSecretLeafValues(source, leaves));
  return leaves;
};

const collectSecretSlots = (sources: ConnectorSecretSlotSources) => {
  const oauthClientSecret = collectConnectorSecretLeaves(sources.oauthClientSecret);
  const sharedSecret = collectConnectorSecretLeaves(sources.sharedSecret);
  return connectorSecretSlotLeavesSchema.parse({
    oauthClientSecret: [...oauthClientSecret],
    sharedSecret: [...sharedSecret],
  });
};

/** Only this server-side loader path can mint a context accepted by the normalizers. */
export const loadTrustedConnectorSecretContext = async (
  loader: ConnectorCurrentSecretLoader,
  connectorId: string,
  replacementSecretSources: ConnectorSecretSlotSources,
): Promise<TrustedConnectorSecretContext> => {
  const currentSources = await loader.loadCurrentSecretSources(connectorId);
  const context = Object.freeze({ source: 'server-secret-store' as const });
  trustedSecretContexts.set(context, {
    connectorId: connectorIdSchema.parse(connectorId),
    current: collectSecretSlots(currentSources),
    replacement: collectSecretSlots(replacementSecretSources),
  });
  return context;
};

const resolveTrustedSecretLeaves = (context: TrustedConnectorSecretContext) => {
  const trusted = trustedSecretContexts.get(context);
  if (!trusted) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
  return trusted;
};

type SecretMutation =
  | z.infer<typeof connectorOAuthClientSecretMutationSchema>
  | z.infer<typeof connectorSharedSecretMutationSchema>
  | undefined;

const applySecretMutationState = (
  current: z.infer<typeof connectorSecretStateSchema>,
  mutation: SecretMutation,
  switchingMode: boolean,
) => {
  if (mutation?.operation === 'clear') return emptySecretState;
  if (mutation?.operation === 'replace') return configuredSecretState;
  return switchingMode ? emptySecretState : current;
};

const assertNoKnownSecret = (value: unknown, secretLeaves: ReadonlySet<string>): void => {
  if (typeof value === 'string') {
    if (
      containsConnectorCredentialMaterial(value) ||
      [...secretLeaves].some((secret) => value.includes(secret))
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoKnownSecret(item, secretLeaves));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, item]) => {
    assertNoKnownSecret(key, secretLeaves);
    assertNoKnownSecret(item, secretLeaves);
  });
};

const assertConnectorPersistentFieldsSafe = (
  draft: z.infer<typeof adminConnectorDraftSchema>,
  reason: string,
  secretContext: TrustedConnectorSecretContext,
): void => {
  const trusted = resolveTrustedSecretLeaves(secretContext);
  const secretLeaves = new Set([
    ...trusted.current.oauthClientSecret,
    ...trusted.current.sharedSecret,
    ...trusted.replacement.oauthClientSecret,
    ...trusted.replacement.sharedSecret,
  ]);
  assertNoKnownSecret(reason, secretLeaves);
  assertNoKnownSecret(
    {
      connectionTestMessage: draft.connectionTest?.messageCode,
      description: draft.description,
      displayName: draft.displayName,
      endpoint: draft.endpoint,
      key: draft.key,
      oauthConfig: draft.oauthConfig,
      tools: draft.tools.map((tool) => ({
        description: tool.description,
        displayName: tool.displayName,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        toolKey: tool.toolKey,
      })),
    },
    secretLeaves,
  );
};

const getSecretLeaves = (secretContext: TrustedConnectorSecretContext): ReadonlySet<string> => {
  const trusted = resolveTrustedSecretLeaves(secretContext);
  return new Set([
    ...trusted.current.oauthClientSecret,
    ...trusted.current.sharedSecret,
    ...trusted.replacement.oauthClientSecret,
    ...trusted.replacement.sharedSecret,
  ]);
};

const assertReplacementLeavesComplete = (
  mutations: { oauthClientSecret: SecretMutation; sharedSecret: SecretMutation },
  secretContext: TrustedConnectorSecretContext,
): void => {
  const provided = resolveTrustedSecretLeaves(secretContext).replacement;
  for (const slot of ['oauthClientSecret', 'sharedSecret'] as const) {
    const mutation = mutations[slot];
    const actual =
      mutation?.operation === 'replace'
        ? collectConnectorSecretLeaves(mutation.value)
        : new Set<string>();
    if (
      actual.size !== provided[slot].length ||
      [...actual].some((secret) => !provided[slot].includes(secret))
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
    }
  }
};

const isConfiguredSlotConsistent = (configured: boolean, leaves: string[]): boolean =>
  configured ? leaves.length > 0 : leaves.length === 0;

const assertConfiguredCurrentSecretsLoaded = (
  draft: z.infer<typeof adminConnectorDraftSchema>,
  secretContext: TrustedConnectorSecretContext,
): void => {
  const trusted = trustedSecretContexts.get(secretContext);
  if (!trusted) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
  if (trusted.connectorId !== draft.id) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  }
  const valid =
    draft.credentialMode === 'none'
      ? trusted.current.sharedSecret.length === 0 && trusted.current.oauthClientSecret.length === 0
      : draft.credentialMode === 'shared_service_account'
        ? isConfiguredSlotConsistent(draft.sharedSecret.configured, trusted.current.sharedSecret) &&
          trusted.current.oauthClientSecret.length === 0
        : isConfiguredSlotConsistent(
            draft.oauthClientSecret.configured,
            trusted.current.oauthClientSecret,
          ) && trusted.current.sharedSecret.length === 0;
  if (!valid) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
};

const assertCreateSecretSlots = (
  draft: z.infer<typeof adminConnectorDraftSchema>,
  secretContext: TrustedConnectorSecretContext,
): void => {
  const trusted = resolveTrustedSecretLeaves(secretContext);
  if (trusted.connectorId !== draft.id) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  }
  if (trusted.current.oauthClientSecret.length > 0 || trusted.current.sharedSecret.length > 0) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
  assertDraftMatchesSecretSlots(draft, trusted.replacement);
};

const assertDraftMatchesSecretSlots = (
  draft: z.infer<typeof adminConnectorDraftSchema>,
  slots: z.infer<typeof connectorSecretSlotLeavesSchema>,
): void => {
  const valid =
    draft.credentialMode === 'none'
      ? slots.sharedSecret.length === 0 && slots.oauthClientSecret.length === 0
      : draft.credentialMode === 'shared_service_account'
        ? isConfiguredSlotConsistent(draft.sharedSecret.configured, slots.sharedSecret) &&
          slots.oauthClientSecret.length === 0
        : isConfiguredSlotConsistent(draft.oauthClientSecret.configured, slots.oauthClientSecret) &&
          slots.sharedSecret.length === 0;
  if (!valid) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
};

export const adminConnectorCreateDerivedInputSchema = z
  .object({
    id: connectorIdSchema,
    serverRedirectUri: httpUrlSchema,
    toolIds: z.array(connectorIdSchema).max(1000),
  })
  .strict();

export const normalizeAdminConnectorCreateInput = (
  input: z.input<typeof adminConnectorCreateDraftInputSchema>,
  derivedInput: z.input<typeof adminConnectorCreateDerivedInputSchema>,
  secretContext: TrustedConnectorSecretContext,
) => {
  const command = adminConnectorCreateDraftInputSchema.parse(input);
  const derivedResult = adminConnectorCreateDerivedInputSchema.safeParse(derivedInput);
  if (!derivedResult.success) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  }
  const derived = derivedResult.data;
  const tools = command.tools ?? [];
  if (tools.length !== derived.toolIds.length) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  }
  const common = {
    connectionTest: null,
    description: command.description ?? null,
    displayName: command.displayName,
    enabled: command.enabled ?? true,
    endpoint: command.endpoint,
    id: derived.id,
    key: command.key,
    revision: 0,
    sort: command.sort ?? 0,
    status: 'draft',
    tools: tools.map((tool, index) => ({ ...tool, id: derived.toolIds[index] })),
    transport: command.transport,
  } as const;
  const draft = adminConnectorDraftSchema.parse(
    command.credentialMode === 'none'
      ? {
          ...common,
          credentialMode: 'none',
          oauthClientSecret: emptySecretState,
          oauthConfig: null,
          sharedSecret: emptySecretState,
        }
      : command.credentialMode === 'shared_service_account'
        ? {
            ...common,
            credentialMode: 'shared_service_account',
            oauthClientSecret: emptySecretState,
            oauthConfig: null,
            sharedSecret: applySecretMutationState(emptySecretState, command.sharedSecret, true),
          }
        : {
            ...common,
            credentialMode: 'per_user_oauth',
            oauthClientSecret: applySecretMutationState(
              emptySecretState,
              command.oauthClientSecret,
              true,
            ),
            oauthConfig: { ...command.oauthConfig, redirectUri: derived.serverRedirectUri },
            sharedSecret: emptySecretState,
          },
  );
  assertCreateSecretSlots(draft, secretContext);
  assertReplacementLeavesComplete(
    {
      oauthClientSecret:
        command.credentialMode === 'per_user_oauth' ? command.oauthClientSecret : undefined,
      sharedSecret:
        command.credentialMode === 'shared_service_account' ? command.sharedSecret : undefined,
    },
    secretContext,
  );
  assertConnectorPersistentFieldsSafe(draft, command.reason, secretContext);
  assertNoKnownSecret(
    {
      description: command.description,
      displayName: command.displayName,
      endpoint: command.endpoint,
      key: command.key,
      oauthConfig: command.credentialMode === 'per_user_oauth' ? command.oauthConfig : null,
      tools: command.tools,
    },
    getSecretLeaves(secretContext),
  );
  return { command, draft };
};

/** Merge a patch with the current complete Draft and re-validate the credential discriminant. */
export const normalizeAdminConnectorUpdateInput = (
  currentInput: z.input<typeof adminConnectorDraftSchema>,
  patchInput: z.input<typeof adminConnectorUpdateDraftInputSchema>,
  serverRedirectUri: string,
  secretContext: TrustedConnectorSecretContext,
) => {
  const current = adminConnectorDraftSchema.parse(currentInput);
  const patch = adminConnectorUpdateDraftInputSchema.parse(patchInput);
  if (patch.id !== current.id) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  }
  const targetMode = patch.credentialMode ?? current.credentialMode;
  const switchingMode = targetMode !== current.credentialMode;
  const redirectUri = httpUrlSchema.parse(serverRedirectUri);
  assertConfiguredCurrentSecretsLoaded(current, secretContext);
  assertReplacementLeavesComplete(
    { oauthClientSecret: patch.oauthClientSecret, sharedSecret: patch.sharedSecret },
    secretContext,
  );

  if (targetMode !== 'shared_service_account' && patch.sharedSecret) {
    clearOnlySecretMutationSchema.parse(patch.sharedSecret);
  }
  if (targetMode !== 'per_user_oauth' && patch.oauthClientSecret) {
    clearOnlySecretMutationSchema.parse(patch.oauthClientSecret);
  }
  if (targetMode !== 'per_user_oauth') z.null().optional().parse(patch.oauthConfig);
  if (targetMode === 'per_user_oauth' && patch.oauthConfig === null) {
    adminConnectorOAuthConfigInputSchema.parse(patch.oauthConfig);
  }

  const oauthConfig =
    targetMode === 'per_user_oauth'
      ? patch.oauthConfig
        ? { ...patch.oauthConfig, redirectUri }
        : current.credentialMode === 'per_user_oauth'
          ? current.oauthConfig
          : null
      : null;
  const currentOauthInput =
    current.credentialMode === 'per_user_oauth'
      ? {
          authorizationEndpoint: current.oauthConfig.authorizationEndpoint,
          clientId: current.oauthConfig.clientId,
          issuer: current.oauthConfig.issuer,
          scopes: current.oauthConfig.scopes,
          tokenEndpoint: current.oauthConfig.tokenEndpoint,
        }
      : undefined;

  const candidate = adminConnectorDraftSchema.parse({
    ...current,
    ...(patch.description !== undefined && { description: patch.description }),
    ...(patch.displayName !== undefined && { displayName: patch.displayName }),
    ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    ...(patch.endpoint !== undefined && { endpoint: patch.endpoint }),
    ...(patch.sort !== undefined && { sort: patch.sort }),
    ...(patch.tools !== undefined && { tools: patch.tools }),
    ...(patch.transport !== undefined && { transport: patch.transport }),
    credentialMode: targetMode,
    oauthClientSecret:
      targetMode === 'per_user_oauth'
        ? applySecretMutationState(
            current.credentialMode === 'per_user_oauth'
              ? current.oauthClientSecret
              : emptySecretState,
            patch.oauthClientSecret,
            switchingMode,
          )
        : emptySecretState,
    oauthConfig,
    sharedSecret:
      targetMode === 'shared_service_account'
        ? applySecretMutationState(
            current.credentialMode === 'shared_service_account'
              ? current.sharedSecret
              : emptySecretState,
            patch.sharedSecret,
            switchingMode,
          )
        : emptySecretState,
  });
  const trusted = resolveTrustedSecretLeaves(secretContext);
  assertDraftMatchesSecretSlots(candidate, {
    oauthClientSecret:
      targetMode !== 'per_user_oauth' || patch.oauthClientSecret?.operation === 'clear'
        ? []
        : patch.oauthClientSecret?.operation === 'replace'
          ? trusted.replacement.oauthClientSecret
          : current.credentialMode === 'per_user_oauth'
            ? trusted.current.oauthClientSecret
            : [],
    sharedSecret:
      targetMode !== 'shared_service_account' || patch.sharedSecret?.operation === 'clear'
        ? []
        : patch.sharedSecret?.operation === 'replace'
          ? trusted.replacement.sharedSecret
          : current.credentialMode === 'shared_service_account'
            ? trusted.current.sharedSecret
            : [],
  });
  assertConnectorPersistentFieldsSafe(candidate, patch.reason, secretContext);

  return {
    candidate,
    patch: {
      ...patch,
      credentialMode: targetMode,
      oauthClientSecret:
        targetMode === 'per_user_oauth' ? patch.oauthClientSecret : clearSecretMutation,
      oauthConfig:
        targetMode === 'per_user_oauth'
          ? (patch.oauthConfig ??
            (currentOauthInput
              ? adminConnectorOAuthConfigInputSchema.parse(currentOauthInput)
              : undefined))
          : null,
      sharedSecret:
        targetMode === 'shared_service_account' ? patch.sharedSecret : clearSecretMutation,
    },
  };
};

const adminConnectorDraftActionInputSchema = z
  .object({ id: connectorIdSchema, reason: reasonSchema })
  .strict();

export const adminConnectorDiscoverInputSchema = adminConnectorDraftActionInputSchema;
export const adminConnectorTestInputSchema = adminConnectorDraftActionInputSchema;

export const adminConnectorDiscoverOutputSchema = z
  .object({
    messageCode: connectorSafeMessageSchema,
    oauthConfig: adminConnectorOAuthConfigSchema.nullable(),
    tools: connectorToolWithoutIdListSchema,
  })
  .strict();

export const adminConnectorTestOutputSchema = z
  .object({
    errorCategory: z.enum(['auth', 'network', 'protocol', 'invalid_config', 'policy']).nullable(),
    latencyMs: z.number().int().nonnegative().nullable(),
    messageCode: connectorSafeMessageSchema,
    status: z.enum(['pending', 'success', 'failure']),
    testedAt: z.date(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.messageCode !== CONNECTOR_OPERATION_MESSAGE_BY_STATUS[value.status]) {
      ctx.addIssue({ code: 'custom', message: 'status and messageCode must match' });
    }
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
export const adminConnectorArchiveInputSchema = adminConnectorPublicationInputSchema;
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

export const managedConnectorToolSchema = publishedConnectorToolObjectSchema
  .omit({
    description: true,
    displayName: true,
    inputSchema: true,
    outputSchema: true,
    platformPolicy: true,
  })
  .extend({
    available: z.boolean(),
    description: publicTextSchema.nullable(),
    displayName: publicDisplayNameSchema,
  })
  .strict();

/** User projection intentionally omits endpoint, transport, OAuth client/config, and secret state. */
export const managedConnectorSchema = z
  .object({
    binding: connectorBindingSchema.nullable(),
    credentialMode: connectorCredentialModeSchema,
    description: publicTextSchema.nullable(),
    displayName: publicDisplayNameSchema,
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
    stateHash: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/),
    stateId: z
      .string()
      .length(32)
      .regex(/^[a-f0-9]+$/),
    userId: connectorIdSchema,
  })
  .strict()
  .refine((value) => value.expiresAt > value.issuedAt, 'OAuth state expiry must follow issuance');

export const connectorOAuthCallbackInputSchema = z
  .object({ code: z.string().trim().min(1).max(8192), state: z.string().trim().min(32).max(512) })
  .strict();

/** Strict provider response boundary; unknown/oversized token fields fail closed. */
export const connectorOAuthTokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(32_768),
    expires_in: z.number().int().nonnegative().max(31_536_000).optional(),
    refresh_token: z.string().min(1).max(32_768).optional(),
    scope: z.string().trim().min(1).max(10_000).optional(),
    token_type: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine(
    (value) => value.token_type === undefined || value.token_type.toLowerCase() === 'bearer',
    'unsupported OAuth token type',
  );

export const connectorEffectiveToolPolicyInputSchema = z
  .object({
    agentAllowed: z.boolean(),
    platformPolicy: connectorPlatformToolPolicySchema,
    userEnabled: z.boolean(),
  })
  .strict();

export const connectorEffectiveToolPolicyOutputSchema = z
  .object({ allowed: z.boolean(), deniedBy: z.enum(['platform', 'agent', 'user']).nullable() })
  .strict()
  .superRefine((value, ctx) => {
    if (value.allowed !== (value.deniedBy === null)) {
      ctx.addIssue({ code: 'custom', message: 'allowed and deniedBy must describe one outcome' });
    }
  });

export const connectorRuntimeResolveInputSchema = z
  .object({
    agentId: connectorIdSchema,
    connectorId: connectorIdSchema,
    expectedPublishedRevision: z.number().int().positive(),
    toolKey: connectorToolKeySchema,
    userId: connectorIdSchema,
  })
  .strict();

const connectorSha256Schema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);

/** Server-owned immutable operation binding. Never accept this from a browser request. */
export const connectorOperationProofSchema = z
  .object({
    connectorId: connectorIdSchema,
    connectorKey: connectorKeySchema,
    operationId: z.string().trim().min(1).max(256),
    publishedChecksum: connectorSha256Schema,
    publishedRevision: z.number().int().positive(),
    toolPolicyFingerprint: connectorSha256Schema,
  })
  .strict();

const connectorRuntimeResolutionBaseSchema = z
  .object({
    connectorId: connectorIdSchema,
    endpoint: httpUrlSchema,
    publishedRevision: z.number().int().positive(),
    tool: publishedConnectorToolSchema,
    transport: webConnectorTransportSchema,
  })
  .strict();

export const connectorRuntimeResolutionSchema = z.discriminatedUnion('credentialMode', [
  connectorRuntimeResolutionBaseSchema.extend({ credentialMode: z.literal('none') }).strict(),
  connectorRuntimeResolutionBaseSchema
    .extend({
      credentialMode: z.literal('shared_service_account'),
      credentials: connectorSharedCredentialSchema,
    })
    .strict(),
  connectorRuntimeResolutionBaseSchema
    .extend({
      accessToken: z.string().min(1).max(32_768),
      bindingId: connectorIdSchema,
      credentialMode: z.literal('per_user_oauth'),
      expiresAt: z.date().nullable(),
      scopes: connectorScopesSchema,
      userId: connectorIdSchema,
    })
    .strict(),
]);

const trustedPublishedConnectorBaseSchema = z
  .object({
    connectorId: connectorIdSchema,
    endpoint: httpUrlSchema,
    publishedRevision: z.number().int().positive(),
    tools: connectorToolDraftListSchema,
    transport: webConnectorTransportSchema,
  })
  .strict();

/** Server-only trusted catalog projection; never return this schema to a client. */
export const trustedPublishedConnectorSchema = z.discriminatedUnion('credentialMode', [
  trustedPublishedConnectorBaseSchema.extend({ credentialMode: z.literal('none') }).strict(),
  trustedPublishedConnectorBaseSchema
    .extend({
      credentialMode: z.literal('shared_service_account'),
      credentials: connectorSharedCredentialSchema,
    })
    .strict(),
  trustedPublishedConnectorBaseSchema
    .extend({
      allowedScopes: connectorScopesSchema,
      credentialMode: z.literal('per_user_oauth'),
    })
    .strict(),
]);

/** Trusted server record; policy booleans never come from the request identity payload. */
export const trustedConnectorToolPolicyRecordSchema = z
  .object({
    agentAllowed: z.boolean(),
    agentId: connectorIdSchema,
    connectorId: connectorIdSchema,
    publishedRevision: z.number().int().positive(),
    toolKey: connectorToolKeySchema,
    userEnabled: z.boolean(),
    userId: connectorIdSchema,
  })
  .strict();

export const trustedConnectorOAuthBindingSchema = z
  .object({
    accessToken: z.string().min(1).max(32_768),
    bindingId: connectorIdSchema,
    connectorId: connectorIdSchema,
    expiresAt: z.date().nullable(),
    publishedRevision: z.number().int().positive(),
    scopes: connectorScopesSchema,
    status: z.literal('connected'),
    userId: connectorIdSchema,
  })
  .strict();

export const ADMIN_CONNECTOR_PROCEDURE_PERMISSIONS = {
  archive: 'platform_connector:delete:all',
  create: 'platform_connector:create:all',
  discover: 'platform_connector:test:all',
  get: 'platform_connector:read:all',
  list: 'platform_connector:read:all',
  publish: 'platform_connector:publish:all',
  revokeAllBindings: 'platform_connector:delete:all',
  rollback: 'platform_connector:publish:all',
  test: 'platform_connector:test:all',
  update: 'platform_connector:update:all',
} as const;
