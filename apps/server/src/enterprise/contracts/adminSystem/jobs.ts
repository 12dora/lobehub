import { z } from 'zod';

import {
  paginationCursorSchema,
  paginationLimitSchema,
  platformJobIdSchema,
  platformJobRevisionSchema,
  reasonSchema,
} from './common';

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

export type AdminSystemCancelJobInput = z.input<typeof adminSystemCancelJobInputSchema>;
export type AdminSystemGetJobsInput = z.input<typeof adminSystemGetJobsInputSchema>;
export type AdminSystemJob = z.infer<typeof adminSystemJobSchema>;
export type AdminSystemRetryJobInput = z.input<typeof adminSystemRetryJobInputSchema>;
