import { z } from 'zod';

import { platformDocumentRenderSettingsSchema } from '@/types/platform/documentRenderSettings';

import { containsEnterpriseSecretMaterial } from '../security/redaction';
import {
  platformConvergenceDomainSchema,
  platformConvergenceErrorCategorySchema,
  platformConvergenceLoadModeSchema,
  platformConvergenceSourceSchema,
  platformConvergenceStatusSchema,
  platformDomainConvergenceSchema,
  platformRevisionTokenSchema,
} from './platformInstanceStatus';

const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(
    (value) => !containsEnterpriseSecretMaterial(value),
    'credential material is not allowed in audit reasons',
  );

const identityRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instanceIdSchema = z.string().regex(/^oidci_[a-f0-9]{48}$/);
const platformJobIdSchema = z.string().regex(/^pjob_[0-9A-Za-z]{16}$/);
const paginationCursorSchema = z.string().regex(/^[\w-]{1,512}$/);
const paginationLimitSchema = z.number().int().min(1).max(50);
const platformJobRevisionSchema = z.number().int().nonnegative();

export const adminSystemDependencyStatusSchema = z.enum([
  'degraded',
  'disabled',
  'healthy',
  'unavailable',
  'unknown',
]);

export const adminSystemDependencyErrorCategorySchema = z.enum([
  'configuration_incomplete',
  'operation_unavailable',
  'passive_check_only',
  'timeout',
]);

const adminSystemDependencyHealthSchema = z
  .object({
    /**
     * Short operator-facing summary of what is configured (provider / engine /
     * target), e.g. "PostgreSQL", "S3 · lobe-files", "SMTP smtp.example.com:587",
     * "Vault". Never contains secrets. Rendered as the tile's first info line.
     */
    detail: z.string().trim().max(120).optional(),
    errorCategory: adminSystemDependencyErrorCategorySchema.nullable(),
    lastCheckedAt: z.date().nullable(),
    /** Round-trip of the last health check in milliseconds (absent when no live probe ran). */
    latencyMs: z.number().int().nonnegative().optional(),
    status: adminSystemDependencyStatusSchema,
    /** Server/engine version reported by the dependency, when cheaply available. */
    version: z.string().trim().max(64).optional(),
  })
  .strict();

export const adminSystemSandboxHealthSchema = adminSystemDependencyHealthSchema
  .extend({
    activeContainers: z.number().int().nonnegative(),
    daemonReachable: z.boolean(),
    imagePresent: z.boolean(),
    lastError: z.string().trim().max(500).optional(),
    maxContainers: z.number().int().positive(),
  })
  .strict();

export const adminSystemDocumentRenderHealthSchema = adminSystemDependencyHealthSchema
  .extend({
    configured: z.boolean(),
    lastError: z.string().trim().max(500).optional(),
    queuePending: z.number().int().nonnegative(),
    queueRunning: z.number().int().nonnegative(),
  })
  .strict();

const validateAvailability = (
  value: { errorCategory: 'operation_unavailable' | null; status: 'healthy' | 'unavailable' },
  context: z.RefinementCtx,
): void => {
  if (value.status === 'healthy' && value.errorCategory) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'healthy data cannot contain an error category',
      path: ['errorCategory'],
    });
  }
  if (value.status === 'unavailable' && !value.errorCategory) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'unavailable data requires an error category',
      path: ['errorCategory'],
    });
  }
};

const adminSystemJobStatusSchema = z.enum([
  'cancelled',
  'dead',
  'failed',
  'pending',
  'reserved',
  'running',
  'succeeded',
]);

export const adminSystemJobKindSchema = z.enum([
  'agent_rollout',
  'ai_oauth_keepalive',
  'ai_oauth_refresh',
  'audit_export',
  'audit_retention',
  'connector_oauth_refresh',
  'connector_runtime',
  'connector_secret_cleanup',
  'secret_rewrap',
  'unknown',
]);

/**
 * Raw queue type behind the operator-facing `kind` label. Purely operational metadata
 * (no identifiers, no payload); `null` when the stored type is not a well-formed queue name,
 * so an unexpected row can never fail the whole page.
 */
const adminSystemJobTypeIdSchema = z.string().regex(/^[a-z0-9.-]{1,64}$/);

export const adminSystemJobSchema = z
  .object({
    attempt: z.number().int().nonnegative(),
    canCancel: z.boolean(),
    canRetry: z.boolean(),
    createdAt: z.date(),
    errorCategory: z.enum(['operation_failed']).nullable(),
    failedCount: z.number().int().nonnegative().nullable(),
    finishedAt: z.date().nullable(),
    jobId: platformJobIdSchema,
    kind: adminSystemJobKindSchema,
    maxAttempts: z.number().int().positive().nullable(),
    progress: z
      .object({
        done: z.number().int().nonnegative(),
        total: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    revision: platformJobRevisionSchema.nullable(),
    startedAt: z.date().nullable(),
    status: adminSystemJobStatusSchema,
    typeId: adminSystemJobTypeIdSchema.nullable(),
    updatedAt: z.date(),
  })
  .strict();

export const adminSystemGetStatusOutputSchema = z
  .object({
    build: z
      .object({
        gitSha: z
          .string()
          .regex(/^[a-f0-9]{7,40}$/)
          .nullable(),
        version: z.string().trim().min(1).max(64),
      })
      .strict(),
    dependencies: z
      .object({
        database: adminSystemDependencyHealthSchema,
        documentRender: adminSystemDocumentRenderHealthSchema.optional(),
        keyManagement: adminSystemDependencyHealthSchema,
        mail: adminSystemDependencyHealthSchema,
        objectStorage: adminSystemDependencyHealthSchema,
        redis: adminSystemDependencyHealthSchema,
        sandbox: adminSystemSandboxHealthSchema.optional(),
      })
      .strict(),
    domains: z.array(platformDomainConvergenceSchema).max(8),
    featureFlags: z
      .object({
        databaseOidc: z.boolean(),
        managedAgents: z.boolean(),
        managedAi: z.boolean(),
        managedConnectors: z.boolean(),
        managedSkills: z.boolean(),
        platformAdmin: z.boolean(),
        runtimeBranding: z.boolean(),
        settingsPolicy: z.boolean(),
      })
      .strict(),
    instanceStatus: adminSystemDependencyHealthSchema,
    jobs: z
      .object({
        active: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        errorCategory: z.enum(['operation_unavailable']).nullable(),
        failed: z.number().int().nonnegative(),
        status: z.enum(['healthy', 'unavailable']),
        total: z.number().int().nonnegative(),
      })
      .strict()
      .superRefine(validateAvailability),
    oidc: z
      .object({
        activeRevision: identityRevisionSchema.nullable(),
        configured: z.boolean(),
        pendingRestart: z.boolean(),
        source: z.enum(['break_glass', 'database', 'disabled', 'environment', 'lkg', 'unknown']),
        status: adminSystemDependencyStatusSchema,
      })
      .strict(),
    recentPublishFailures: z
      .object({
        count: z.number().int().nonnegative(),
        errorCategory: z.enum(['operation_unavailable']).nullable(),
        items: z
          .array(
            z
              .object({
                category: z.enum([
                  'conflict',
                  'dependency_unavailable',
                  'operation_unavailable',
                  'unknown',
                  'validation',
                ]),
                domain: platformConvergenceDomainSchema,
                occurredAt: z.date(),
              })
              .strict(),
          )
          .max(10),
        status: z.enum(['healthy', 'unavailable']),
      })
      .strict()
      .superRefine(validateAvailability),
    snapshotAt: z.date(),
  })
  .strict();

/**
 * Registry rows are process-registration history, not a live service list. `live` (the default)
 * hides processes whose heartbeat is older than the staleness window.
 */
export const adminSystemInstanceStateSchema = z.enum(['all', 'live', 'offline']);

export const adminSystemGetInstanceRevisionsInputSchema = z
  .object({
    cursor: paginationCursorSchema.optional(),
    limit: paginationLimitSchema.optional(),
    state: adminSystemInstanceStateSchema.optional(),
  })
  .strict()
  .optional();

const adminSystemInstanceDomainSchema = z
  .object({
    domain: platformConvergenceDomainSchema,
    lastErrorCategory: platformConvergenceErrorCategorySchema.nullable(),
    loadedAt: z.date().nullable(),
    loadedToken: platformRevisionTokenSchema.nullable(),
    loadMode: platformConvergenceLoadModeSchema,
    source: platformConvergenceSourceSchema,
    status: platformConvergenceStatusSchema,
  })
  .strict();

const platformInstanceIdSchema = z.union([
  z.string().regex(/^pinst_[a-f0-9]{48}$/),
  instanceIdSchema,
]);

export const adminSystemInstanceRevisionSchema = z
  .object({
    domains: z.array(adminSystemInstanceDomainSchema).min(1).max(7),
    fresh: z.boolean(),
    instanceId: platformInstanceIdSchema,
    instanceKind: z.enum(['identity_startup', 'platform']),
    lagging: z.boolean(),
    lastHeartbeatAt: z.date(),
    pendingRestart: z.boolean(),
    startedAt: z.date(),
  })
  .strict();

export const adminSystemGetInstanceRevisionsOutputSchema = z
  .object({
    /**
     * Registry totals evaluated against this page's snapshot clock, independent of the
     * `state` filter. Attached to the first page only (`null` on cursor pages).
     */
    counts: z
      .object({
        live: z.number().int().nonnegative(),
        offline: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    domains: z.array(platformDomainConvergenceSchema).max(8),
    items: z.array(adminSystemInstanceRevisionSchema).max(50),
    nextCursor: paginationCursorSchema.nullable(),
    snapshotAt: z.date(),
    /**
     * Fingerprint of the domain-target set used to evaluate this page.
     * Clients must not accumulate pages with differing targetRevision values.
     */
    targetRevision: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();

export const adminSystemGetJobsInputSchema = z
  .object({
    cursor: paginationCursorSchema.optional(),
    limit: paginationLimitSchema.optional(),
  })
  .strict()
  .optional();

export const adminSystemGetJobsOutputSchema = z
  .object({
    items: z.array(adminSystemJobSchema).max(50),
    nextCursor: paginationCursorSchema.nullable(),
  })
  .strict();

const jobMutationIntentSchema = z
  .object({
    expectedRevision: platformJobRevisionSchema,
    jobId: platformJobIdSchema,
    /**
     * Job control is an operational action the console no longer prompts for. A supplied reason
     * is still bounded and secret-scanned; omitted reasons persist as a null audit column.
     */
    reason: reasonSchema.optional(),
    requestId: z.string().uuid(),
  })
  .strict();

export const adminSystemCancelJobInputSchema = jobMutationIntentSchema
  .extend({ expectedStatus: z.enum(['pending', 'running']) })
  .strict();
export const adminSystemCancelJobOutputSchema = adminSystemJobSchema;

export const adminSystemRetryJobInputSchema = jobMutationIntentSchema
  .extend({ expectedStatus: z.enum(['cancelled', 'dead', 'failed']) })
  .strict();
export const adminSystemRetryJobOutputSchema = adminSystemJobSchema;

export const adminSystemAuthSnapshotStatusOutputSchema = z
  .object({
    active: z.object({
      allFreshInstancesActive: z.boolean(),
      partial: z.boolean(),
      staleInstances: z.number().int().nonnegative(),
    }),
    artifact: z.object({
      degradedCategory: z
        .string()
        .regex(/^[a-z0-9_]{1,128}$/)
        .nullable(),
      generation: z.string().nullable(),
      health: z.enum(['degraded', 'healthy']),
      identityRevision: identityRevisionSchema.nullable(),
      instanceId: instanceIdSchema,
      loadedAt: z.date(),
      source: z.enum(['break_glass', 'database', 'environment', 'lkg']),
    }),
    instances: z.array(
      z.object({
        activeIdentityRevision: identityRevisionSchema.nullable(),
        degradedCategory: z
          .string()
          .regex(/^[a-z0-9_]{1,128}$/)
          .nullable(),
        fresh: z.boolean(),
        health: z.enum(['degraded', 'healthy']),
        hostnameHash: identityRevisionSchema,
        instanceId: instanceIdSchema,
        lastHeartbeat: z.date(),
        loadedAt: z.date(),
        startedAt: z.date(),
        startupGeneration: z.string().nullable(),
        startupSource: z.enum(['break_glass', 'database', 'environment', 'lkg']),
      }),
    ),
    pendingPublished: z.array(
      z.object({
        blockedCategory: z.enum(['environment_provider_shadowed']).nullable(),
        providerId: z.string().min(1),
        providerKey: z.string().min(1),
        publishedRevision: z.number().int().positive(),
      }),
    ),
    pendingRestart: z.boolean(),
    restart: z.object({
      reason: z
        .enum([
          'edge_runtime',
          'environment_provider_shadowed',
          'no_pending_restart',
          'serverless_runtime',
          'supervisor_not_configured',
          'test_runtime',
        ])
        .nullable(),
      supported: z.boolean(),
    }),
    /**
     * Most recent accepted/signaled/failed restart request for this instance.
     * Lets the admin UI fail closed immediately when scheduling fails, instead of
     * waiting for the convergence deadline.
     */
    restartRequest: z
      .object({
        requestId: z.string().uuid(),
        resultCategory: z
          .string()
          .regex(/^[a-z0-9_]{1,128}$/)
          .nullable(),
        status: z.enum(['accepted', 'failed', 'signaled']),
      })
      .nullable(),
    /**
     * Bounded recent restart requests for this instance (newest first).
     * Concurrent restarts must not hide a failed request the admin is polling.
     */
    restartRequests: z
      .array(
        z.object({
          requestId: z.string().uuid(),
          resultCategory: z
            .string()
            .regex(/^[a-z0-9_]{1,128}$/)
            .nullable(),
          status: z.enum(['accepted', 'failed', 'signaled']),
        }),
      )
      .max(32),
    targetIdentityRevision: identityRevisionSchema.nullable(),
  })
  .strict();

export const adminSystemPrepareRestartInputSchema = z
  .object({ reason: reasonSchema, requestId: z.string().uuid() })
  .strict();
export const adminSystemPrepareRestartOutputSchema = z
  .object({
    expectedIdentityRevision: identityRevisionSchema,
    expiresAt: z.date(),
    intentToken: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z.string().uuid(),
  })
  .strict();

export const adminSystemRequestRestartInputSchema = adminSystemPrepareRestartInputSchema
  .extend({ intentToken: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const adminSystemRequestRestartOutputSchema = z
  .object({
    accepted: z.literal(true),
    acceptedAt: z.date(),
    convergenceDeadlineAt: z.date(),
    duplicate: z.boolean(),
    expectedIdentityRevision: identityRevisionSchema,
    remainingMs: z.number().int().nonnegative().max(120_000),
    requestId: z.string().uuid(),
    serverNow: z.date(),
    status: z.enum(['accepted', 'signaled']),
  })
  .strict();

export const adminSystemInfraDependencySchema = z.enum(['documentRender', 'mail', 'objectStorage']);

export const adminSystemTestDependencyReasonSchema = z.enum([
  'configured_unverified',
  'configuration_incomplete',
  'not_configured',
  'timeout',
  'unauthorized',
  'unreachable',
]);

const infraSecretActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z
    .object({
      action: z.literal('replace'),
      value: z.string().min(1).max(512),
    })
    .strict(),
]);

const requireWhenEnabled = (
  enabled: boolean,
  ctx: z.RefinementCtx,
  fields: Array<{ message: string; path: Array<number | string>; present: boolean }>,
) => {
  if (!enabled) return;
  for (const field of fields) {
    if (field.present) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: field.message,
      path: field.path,
    });
  }
};

export const adminSystemObjectStorageConfigSchema = z
  .object({
    accessKeyId: z.string().trim().min(1).max(128).optional(),
    bucket: z.string().trim().min(1).max(255).optional(),
    enabled: z.boolean(),
    endpoint: z.string().trim().url().max(2048).optional(),
    forcePathStyle: z.boolean().optional(),
    previewUrlExpireIn: z.number().int().min(60).max(604_800).optional(),
    publicDomain: z.string().trim().url().max(2048).optional(),
    region: z.string().trim().max(64).optional(),
    secretAccessKey: infraSecretActionSchema.default({ action: 'keep' }),
    setAcl: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireWhenEnabled(value.enabled, ctx, [
      {
        message: 'accessKeyId is required when enabled',
        path: ['accessKeyId'],
        present: Boolean(value.accessKeyId),
      },
      {
        message: 'bucket is required when enabled',
        path: ['bucket'],
        present: Boolean(value.bucket),
      },
      {
        message: 'forcePathStyle is required when enabled',
        path: ['forcePathStyle'],
        present: value.forcePathStyle !== undefined,
      },
      {
        message: 'setAcl is required when enabled',
        path: ['setAcl'],
        present: value.setAcl !== undefined,
      },
      {
        message: 'endpoint is required when region is not set',
        path: ['endpoint'],
        present: Boolean(value.endpoint || value.region),
      },
    ]);
  });

export const adminSystemMailConfigSchema = z
  .object({
    enabled: z.boolean(),
    fromAddress: z.string().trim().email().max(320).optional(),
    provider: z.enum(['smtp', 'resend']).optional(),
    resend: z
      .object({ apiKey: infraSecretActionSchema.default({ action: 'keep' }) })
      .strict()
      .optional(),
    senderName: z.string().trim().max(256).optional(),
    smtp: z
      .object({
        host: z.string().trim().min(1).max(255).optional(),
        pass: infraSecretActionSchema.default({ action: 'keep' }),
        port: z.number().int().min(1).max(65_535).optional(),
        secure: z.boolean().optional(),
        user: z.string().trim().min(1).max(320).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireWhenEnabled(value.enabled, ctx, [
      {
        message: 'fromAddress is required when enabled',
        path: ['fromAddress'],
        present: Boolean(value.fromAddress),
      },
      {
        message: 'provider is required when enabled',
        path: ['provider'],
        present: Boolean(value.provider),
      },
      {
        message: 'smtp is required when provider is smtp',
        path: ['smtp'],
        present: value.provider !== 'smtp' || Boolean(value.smtp),
      },
      {
        message: 'smtp.host is required when enabled',
        path: ['smtp', 'host'],
        present: value.provider !== 'smtp' || Boolean(value.smtp?.host),
      },
      {
        message: 'smtp.port is required when enabled',
        path: ['smtp', 'port'],
        present: value.provider !== 'smtp' || value.smtp?.port !== undefined,
      },
      {
        message: 'smtp.secure is required when enabled',
        path: ['smtp', 'secure'],
        present: value.provider !== 'smtp' || value.smtp?.secure !== undefined,
      },
      {
        message: 'smtp.user is required when enabled',
        path: ['smtp', 'user'],
        present: value.provider !== 'smtp' || Boolean(value.smtp?.user),
      },
      {
        message: 'resend is required when provider is resend',
        path: ['resend'],
        present: value.provider !== 'resend' || Boolean(value.resend),
      },
    ]);
  });

export const adminSystemTestDependencyInputSchema = z
  .object({
    dependency: adminSystemInfraDependencySchema,
    draft: z.union([adminSystemObjectStorageConfigSchema, adminSystemMailConfigSchema]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.draft) return;
    const isStorageDraft = 'bucket' in value.draft;
    if (value.dependency === 'objectStorage' && !isStorageDraft) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'draft must be an objectStorage config',
        path: ['draft'],
      });
    }
    if (value.dependency === 'mail' && isStorageDraft) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'draft must be a mail config',
        path: ['draft'],
      });
    }
    if (value.dependency === 'documentRender') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'draft is not supported for documentRender',
        path: ['draft'],
      });
    }
  });

export const adminSystemTestDependencyOutputSchema = z
  .object({
    checkedAt: z.date(),
    latencyMs: z.number().int().nonnegative().max(30_000),
    message: adminSystemTestDependencyReasonSchema.optional(),
    ok: z.boolean(),
  })
  .strict();

export const adminSystemGetInfraSettingsOutputSchema = z
  .object({
    mail: z
      .object({
        enabled: z.boolean(),
        errorCategory: adminSystemDependencyErrorCategorySchema.nullable(),
        fromAddress: z.string().trim().max(320).nullable(),
        hasResendApiKey: z.boolean(),
        hasSmtpPass: z.boolean(),
        host: z.string().trim().max(255).nullable(),
        port: z.number().int().min(1).max(65_535).nullable(),
        provider: z.enum(['resend', 'smtp', 'unconfigured']),
        revision: z.number().int().nonnegative(),
        secure: z.boolean().nullable(),
        senderName: z.string().trim().max(256).nullable(),
        smtpUser: z.string().trim().max(320).nullable(),
        source: z.enum(['db', 'env']),
        status: adminSystemDependencyStatusSchema,
      })
      .strict(),
    objectStorage: z
      .object({
        accessId: z.string().trim().max(128).nullable(),
        bucket: z.string().trim().max(255).nullable(),
        enabled: z.boolean(),
        endpoint: z.string().trim().max(2048).nullable(),
        errorCategory: adminSystemDependencyErrorCategorySchema.nullable(),
        hasSecretAccessKey: z.boolean(),
        pathStyle: z.boolean(),
        previewUrlExpireIn: z.number().int().nullable(),
        publicDomain: z.string().trim().max(2048).nullable(),
        region: z.string().trim().max(64).nullable(),
        revision: z.number().int().nonnegative(),
        setAcl: z.boolean(),
        source: z.enum(['db', 'env']),
        status: adminSystemDependencyStatusSchema,
      })
      .strict(),
    snapshotAt: z.date(),
  })
  .strict();

export const adminSystemUpdateInfraSettingsInputSchema = z.discriminatedUnion('dependency', [
  z
    .object({
      config: adminSystemObjectStorageConfigSchema,
      dependency: z.literal('objectStorage'),
      expectedRevision: z.number().int().nonnegative(),
      reason: reasonSchema.optional(),
    })
    .strict(),
  z
    .object({
      config: adminSystemMailConfigSchema,
      dependency: z.literal('mail'),
      expectedRevision: z.number().int().nonnegative(),
      reason: reasonSchema.optional(),
    })
    .strict(),
]);

export const adminSystemUpdateInfraSettingsOutputSchema = z
  .object({
    appliedAt: z.date(),
    revision: z.number().int().nonnegative(),
    source: z.enum(['db', 'env']),
  })
  .strict();

export type AdminSystemPrepareRestartInput = z.infer<typeof adminSystemPrepareRestartInputSchema>;
export type AdminSystemRequestRestartInput = z.infer<typeof adminSystemRequestRestartInputSchema>;
export type AdminSystemCancelJobInput = z.input<typeof adminSystemCancelJobInputSchema>;
export type AdminSystemGetInstanceRevisionsInput = z.input<
  typeof adminSystemGetInstanceRevisionsInputSchema
>;
export type AdminSystemGetJobsInput = z.input<typeof adminSystemGetJobsInputSchema>;
export type AdminSystemInstanceState = z.infer<typeof adminSystemInstanceStateSchema>;
export type AdminSystemJob = z.infer<typeof adminSystemJobSchema>;
export type AdminSystemRetryJobInput = z.input<typeof adminSystemRetryJobInputSchema>;
export type AdminSystemInfraDependency = z.infer<typeof adminSystemInfraDependencySchema>;
export type AdminSystemTestDependencyInput = z.input<typeof adminSystemTestDependencyInputSchema>;
export type AdminSystemTestDependencyReason = z.infer<typeof adminSystemTestDependencyReasonSchema>;
export type AdminSystemGetInfraSettings = z.infer<typeof adminSystemGetInfraSettingsOutputSchema>;
export type AdminSystemGetInfraSettingsOutput = AdminSystemGetInfraSettings;
export type AdminSystemInfraSecretAction = z.infer<typeof infraSecretActionSchema>;
export type AdminSystemObjectStorageConfig = z.infer<typeof adminSystemObjectStorageConfigSchema>;
export type AdminSystemMailConfig = z.infer<typeof adminSystemMailConfigSchema>;
export type AdminSystemUpdateInfraSettingsInput = z.input<
  typeof adminSystemUpdateInfraSettingsInputSchema
>;
export type AdminSystemUpdateInfraSettingsOutput = z.infer<
  typeof adminSystemUpdateInfraSettingsOutputSchema
>;

export const adminSystemSandboxProviderSchema = z.enum(['local', 'market', 'onlyboxes']);
export const adminSystemSandboxPullPolicySchema = z.enum(['always', 'if-missing', 'never']);
export const adminSystemSandboxNetworkSchema = z.enum(['bridge', 'none']);

const requireSandboxLocalFields = (
  value: {
    enabled: boolean;
    provider?: 'local' | 'market' | 'onlyboxes';
  } & Record<string, unknown>,
  ctx: z.RefinementCtx,
): void => {
  if (!value.enabled) return;
  if (!value.provider) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provider is required when enabled',
      path: ['provider'],
    });
    return;
  }
  if (value.provider !== 'local') return;
  requireWhenEnabled(true, ctx, [
    {
      message: 'dockerSocket is required when provider is local',
      path: ['dockerSocket'],
      present: Boolean(value.dockerSocket),
    },
    {
      message: 'image is required when provider is local',
      path: ['image'],
      present: Boolean(value.image),
    },
    {
      message: 'pullPolicy is required when provider is local',
      path: ['pullPolicy'],
      present: value.pullPolicy !== undefined,
    },
    {
      message: 'network is required when provider is local',
      path: ['network'],
      present: value.network !== undefined,
    },
    {
      message: 'memoryMb is required when provider is local',
      path: ['memoryMb'],
      present: value.memoryMb !== undefined,
    },
    {
      message: 'pidsLimit is required when provider is local',
      path: ['pidsLimit'],
      present: value.pidsLimit !== undefined,
    },
    {
      message: 'cpus is required when provider is local',
      path: ['cpus'],
      present: value.cpus !== undefined,
    },
    {
      message: 'timeoutMs is required when provider is local',
      path: ['timeoutMs'],
      present: value.timeoutMs !== undefined,
    },
    {
      message: 'maxOutputBytes is required when provider is local',
      path: ['maxOutputBytes'],
      present: value.maxOutputBytes !== undefined,
    },
    {
      message: 'idleTtlSec is required when provider is local',
      path: ['idleTtlSec'],
      present: value.idleTtlSec !== undefined,
    },
    {
      message: 'maxContainers is required when provider is local',
      path: ['maxContainers'],
      present: value.maxContainers !== undefined,
    },
  ]);
};

export const adminSystemSandboxSettingsConfigSchema = z
  .object({
    cpus: z.number().positive().optional(),
    dockerHost: z.string().trim().max(512).optional(),
    dockerSocket: z.string().trim().min(1).max(512).optional(),
    enabled: z.boolean(),
    idleTtlSec: z.number().int().positive().optional(),
    image: z.string().trim().min(1).max(256).optional(),
    maxContainers: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    memoryMb: z.number().int().positive().optional(),
    network: adminSystemSandboxNetworkSchema.optional(),
    pidsLimit: z.number().int().positive().optional(),
    provider: adminSystemSandboxProviderSchema.optional(),
    pullPolicy: adminSystemSandboxPullPolicySchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine(requireSandboxLocalFields);

export const adminSystemGetSandboxSettingsOutputSchema = z
  .object({
    cpus: z.number().positive(),
    dockerHost: z.string().trim().max(512).nullable(),
    dockerSocket: z.string().trim().min(1).max(512),
    enabled: z.boolean(),
    idleTtlSec: z.number().int().positive(),
    image: z.string().trim().min(1).max(256),
    maxContainers: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    memoryMb: z.number().int().positive(),
    moduleEnabled: z.boolean(),
    network: adminSystemSandboxNetworkSchema,
    pidsLimit: z.number().int().positive(),
    provider: adminSystemSandboxProviderSchema,
    pullPolicy: adminSystemSandboxPullPolicySchema,
    revision: z.number().int().nonnegative(),
    source: z.enum(['db', 'env']),
    timeoutMs: z.number().int().positive(),
  })
  .strict();

export const adminSystemUpdateSandboxSettingsInputSchema = z
  .object({
    config: adminSystemSandboxSettingsConfigSchema,
    expectedRevision: z.number().int().nonnegative(),
    reason: reasonSchema.optional(),
  })
  .strict();

export const adminSystemUpdateSandboxSettingsOutputSchema =
  adminSystemGetSandboxSettingsOutputSchema;

export type AdminSystemSandboxHealth = z.infer<typeof adminSystemSandboxHealthSchema>;
export type AdminSystemGetSandboxSettings = z.infer<
  typeof adminSystemGetSandboxSettingsOutputSchema
>;
export type AdminSystemGetSandboxSettingsOutput = AdminSystemGetSandboxSettings;
export type AdminSystemSandboxSettingsConfig = z.infer<
  typeof adminSystemSandboxSettingsConfigSchema
>;
export type AdminSystemUpdateSandboxSettingsInput = z.input<
  typeof adminSystemUpdateSandboxSettingsInputSchema
>;
export type AdminSystemUpdateSandboxSettingsOutput = z.infer<
  typeof adminSystemUpdateSandboxSettingsOutputSchema
>;

export const adminSystemDocumentRenderJobIdSchema = z.string().trim().min(1).max(128);

export const adminSystemDocumentRenderResolvedConfigSchema = z
  .object({
    concurrency: z.number().int().positive(),
    contactSheetCols: z.number().int().min(1).max(6),
    contactSheetRows: z.number().int().min(1).max(8),
    endpoint: z.string().trim().max(512).nullable(),
    longEdgePx: z.number().int().min(256).max(4096),
    maxDocsPerRequest: z.number().int().positive(),
    maxFileBytes: z.number().int().positive(),
    maxImagesDefault: z.number().int().positive(),
    maxPages: z.number().int().positive(),
    mediaThresholdT2: z.number().int().positive(),
    pptxAlwaysT2: z.boolean(),
    retentionDays: z.number().int().nonnegative(),
    thumbEdgePx: z.number().int().min(128).max(1024),
    tilesForDensePages: z.boolean(),
    timeoutSec: z.number().int().positive(),
    trigger: z.enum(['onDemand', 'onUpload']),
  })
  .strict();

export const adminSystemGetDocumentRenderSettingsOutputSchema = z
  .object({
    config: adminSystemDocumentRenderResolvedConfigSchema,
    enabled: z.boolean(),
    moduleEnabled: z.boolean(),
    revision: z.number().int().nonnegative(),
    source: z.enum(['db', 'env']),
  })
  .strict();

export const adminSystemUpdateDocumentRenderSettingsInputSchema = z
  .object({
    config: platformDocumentRenderSettingsSchema,
    expectedRevision: z.number().int().nonnegative(),
    reason: reasonSchema.optional(),
  })
  .strict();

export const adminSystemUpdateDocumentRenderSettingsOutputSchema =
  adminSystemGetDocumentRenderSettingsOutputSchema;

export const adminSystemDocumentRenderQueueRecentSchema = z
  .object({
    durationMs: z.number().int().nonnegative().nullable(),
    error: z.string().nullable(),
    ext: z.string(),
    fileId: z.string(),
    finishedAt: z.string().nullable(),
    id: z.string(),
    pages: z.number().int().nonnegative().nullable(),
    status: z.string(),
  })
  .strict();

/**
 * Per-process feed counters (since process start). Reset on restart; the
 * status page labels them accordingly.
 */
export const adminSystemDocumentRenderFeedStatsSchema = z
  .object({
    /** Requests where a document was still `pending` and the feed fell back to text. */
    pendingFallbacks: z.number().int().nonnegative(),
    /** Requests where the feed waited for a fresh pending render. */
    pendingWaits: z.number().int().nonnegative(),
    /** Documents that contributed at least one stored image. */
    docsFed: z.number().int().nonnegative(),
    /** Stored images (contact sheets + pages + tiles) attached to requests. */
    imagesFed: z.number().int().nonnegative(),
    /** Requests that attached at least one stored image. */
    requestsWithImages: z.number().int().nonnegative(),
    /** ISO timestamp of the counter epoch (process start). */
    since: z.string(),
    /** `viewDocumentPages` tool calls served with images. */
    toolPageViews: z.number().int().nonnegative(),
  })
  .strict();

/** Summary of the last completed `platform.document.render.gc.v1` job. */
export const adminSystemDocumentRenderMaintenanceSchema = z
  .object({
    /** Total objects / bytes under `files/render/` after the last sweep. */
    artifactBytes: z.number().int().nonnegative().nullable(),
    artifactObjects: z.number().int().nonnegative().nullable(),
    /** Files whose artifacts were removed because `retentionDays` elapsed. */
    expiredFiles: z.number().int().nonnegative().nullable(),
    /** Last GC job status (`succeeded` / `failed` / `dead` / `running` / `pending`) or null when never run. */
    jobStatus: z.string().nullable(),
    lastError: z.string().nullable(),
    lastRunAt: z.string().nullable(),
    /** Orphan objects (no owning `files` row) deleted by the last sweep. */
    orphanBytes: z.number().int().nonnegative().nullable(),
    orphanObjects: z.number().int().nonnegative().nullable(),
    /** Bytes currently under the worker temp dir (`os.tmpdir()/aihub-render`). */
    tempDirBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const adminSystemRunDocumentRenderGcInputSchema = z.object({}).strict();
export const adminSystemRunDocumentRenderGcOutputSchema = z
  .object({ jobId: z.string().nullable(), ok: z.boolean() })
  .strict();

export const adminSystemGetDocumentRenderStatusOutputSchema = z
  .object({
    configured: z.boolean(),
    feed: adminSystemDocumentRenderFeedStatsSchema,
    maintenance: adminSystemDocumentRenderMaintenanceSchema,
    moduleEnabled: z.boolean(),
    queue: z
      .object({
        avgMs: z.number().nullable(),
        failed24h: z.number().int().nonnegative(),
        p95Ms: z.number().nullable(),
        pending: z.number().int().nonnegative(),
        recent: z.array(adminSystemDocumentRenderQueueRecentSchema).max(20),
        running: z.number().int().nonnegative(),
        succeeded24h: z.number().int().nonnegative(),
      })
      .strict(),
    sidecar: z
      .object({
        checkedAt: z.string(),
        error: z.string().optional(),
        latencyMs: z.number().int().nonnegative().optional(),
        status: z.enum(['disabled', 'down', 'unconfigured', 'up']),
        version: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export const adminSystemRetryDocumentRenderJobInputSchema = z
  .object({ jobId: adminSystemDocumentRenderJobIdSchema })
  .strict();
export const adminSystemRetryDocumentRenderJobOutputSchema = z.object({ ok: z.boolean() }).strict();

export const adminSystemCancelDocumentRenderJobInputSchema = z
  .object({ jobId: adminSystemDocumentRenderJobIdSchema })
  .strict();
export const adminSystemCancelDocumentRenderJobOutputSchema = z
  .object({ ok: z.boolean() })
  .strict();

export type AdminSystemDocumentRenderHealth = z.infer<typeof adminSystemDocumentRenderHealthSchema>;
export type AdminSystemGetDocumentRenderSettings = z.infer<
  typeof adminSystemGetDocumentRenderSettingsOutputSchema
>;
export type AdminSystemGetDocumentRenderSettingsOutput = AdminSystemGetDocumentRenderSettings;
export type AdminSystemUpdateDocumentRenderSettingsInput = z.input<
  typeof adminSystemUpdateDocumentRenderSettingsInputSchema
>;
export type AdminSystemUpdateDocumentRenderSettingsOutput = z.infer<
  typeof adminSystemUpdateDocumentRenderSettingsOutputSchema
>;
export type AdminSystemGetDocumentRenderStatus = z.infer<
  typeof adminSystemGetDocumentRenderStatusOutputSchema
>;
export type AdminSystemGetDocumentRenderStatusOutput = AdminSystemGetDocumentRenderStatus;
export type AdminSystemDocumentRenderFeedStats = z.infer<
  typeof adminSystemDocumentRenderFeedStatsSchema
>;
export type AdminSystemDocumentRenderMaintenance = z.infer<
  typeof adminSystemDocumentRenderMaintenanceSchema
>;
export type AdminSystemRunDocumentRenderGcOutput = z.infer<
  typeof adminSystemRunDocumentRenderGcOutputSchema
>;

// ---------------------------------------------------------------------------
// Sandbox package-install ledger (admin.system.getSandboxPackageStats)
// ---------------------------------------------------------------------------

export const SANDBOX_PACKAGE_MANAGERS = ['apt', 'npm', 'pip'] as const;
export const sandboxPackageManagerSchema = z.enum(SANDBOX_PACKAGE_MANAGERS);
export type SandboxPackageManager = z.infer<typeof sandboxPackageManagerSchema>;

export const adminSystemGetSandboxPackageStatsInputSchema = z
  .object({
    /** Look-back window in days (installs older than this are ignored). */
    days: z.number().int().min(1).max(365).default(30),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const adminSystemSandboxPackageStatSchema = z
  .object({
    /**
     * Lifetime install invocations (attempts, success not verified) of this package by the
     * users who touched it inside the window — the ledger keeps one counter per
     * (user, manager, package), not per event, so this is "how popular", not "how many this month".
     */
    installs: z.number().int().nonnegative(),
    lastInstalledAt: z.date(),
    manager: sandboxPackageManagerSchema,
    package: z.string().trim().min(1).max(120),
    /** Already baked into the sandbox image (Dockerfile.sandbox preinstall list). */
    preinstalled: z.boolean(),
    /** Distinct users who installed it in the window. */
    users: z.number().int().nonnegative(),
  })
  .strict();

export const adminSystemGetSandboxPackageStatsOutputSchema = z
  .object({
    generatedAt: z.date(),
    items: z.array(adminSystemSandboxPackageStatSchema).max(100),
    /** Current image preinstall list (pip package names, lowercase). */
    preinstalled: z.array(z.string()).max(200),
    /** Distinct (manager, package) pairs recorded in the window. */
    totalPackages: z.number().int().nonnegative(),
    windowDays: z.number().int().positive(),
  })
  .strict();

export type AdminSystemGetSandboxPackageStatsInput = z.input<
  typeof adminSystemGetSandboxPackageStatsInputSchema
>;
export type AdminSystemGetSandboxPackageStatsOutput = z.infer<
  typeof adminSystemGetSandboxPackageStatsOutputSchema
>;
export type AdminSystemSandboxPackageStat = z.infer<typeof adminSystemSandboxPackageStatSchema>;
