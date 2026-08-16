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
    reason: reasonSchema,
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
