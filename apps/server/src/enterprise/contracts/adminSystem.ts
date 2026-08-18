import { z } from 'zod';

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
    errorCategory: adminSystemDependencyErrorCategorySchema.nullable(),
    lastCheckedAt: z.date().nullable(),
    status: adminSystemDependencyStatusSchema,
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
        keyManagement: adminSystemDependencyHealthSchema,
        mail: adminSystemDependencyHealthSchema,
        objectStorage: adminSystemDependencyHealthSchema,
        redis: adminSystemDependencyHealthSchema,
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

export const adminSystemInfraDependencySchema = z.enum(['mail', 'objectStorage']);

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
