import { z } from 'zod';

import {
  platformSecretRewrapJobIdSchema,
  platformSecretRewrapKeyIdSchema,
  platformSecretRewrapReasonSchema,
  platformSecretRewrapResultSchema,
} from '../services/secretRewrap/contracts';

const requestIdSchema = z.string().uuid();
const revisionSchema = z.number().int().nonnegative();

export const adminSecretRotationJobSchema = z
  .object({
    counts: platformSecretRewrapResultSchema,
    jobId: platformSecretRewrapJobIdSchema,
    revision: revisionSchema,
    status: z.enum(['cancelled', 'dead', 'failed', 'pending', 'reserved', 'running', 'succeeded']),
    targetKeyId: platformSecretRewrapKeyIdSchema,
    updatedAt: z.date(),
  })
  .strict();

export const adminSecretRotationGetInputSchema = z
  .object({ jobId: platformSecretRewrapJobIdSchema })
  .strict();
export const adminSecretRotationGetOutputSchema = adminSecretRotationJobSchema;

export const adminSecretRotationListInputSchema = z
  .object({
    cursor: platformSecretRewrapJobIdSchema.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .optional();
export const adminSecretRotationListOutputSchema = z
  .object({
    items: z.array(adminSecretRotationJobSchema),
    nextCursor: platformSecretRewrapJobIdSchema.nullable(),
  })
  .strict();

const mutationIntentSchema = z.object({
  reason: platformSecretRewrapReasonSchema,
  requestId: requestIdSchema,
});

export const adminSecretRotationStartInputSchema = mutationIntentSchema
  .extend({ targetKeyId: platformSecretRewrapKeyIdSchema })
  .strict();
export const adminSecretRotationStartOutputSchema = adminSecretRotationJobSchema;

export const adminSecretRotationCancelInputSchema = mutationIntentSchema
  .extend({
    expectedRevision: revisionSchema,
    expectedStatus: z.enum(['pending', 'running']),
    jobId: platformSecretRewrapJobIdSchema,
  })
  .strict();
export const adminSecretRotationCancelOutputSchema = adminSecretRotationJobSchema;

export const adminSecretRotationRetryInputSchema = mutationIntentSchema
  .extend({
    expectedRevision: revisionSchema,
    expectedStatus: z.literal('failed'),
    jobId: platformSecretRewrapJobIdSchema,
  })
  .strict();
export const adminSecretRotationRetryOutputSchema = adminSecretRotationJobSchema;

/**
 * Restart a terminal cancelled/dead job as a new generation.
 * Distinct from failed-ledger retry: cancelled/dead jobs have no failure ledger.
 * `requestId` is the client-supplied generation/idempotency identifier for this restart.
 * Server coordinator implementation is a separate batch.
 */
export const adminSecretRotationRestartInputSchema = mutationIntentSchema
  .extend({
    expectedRevision: revisionSchema,
    expectedStatus: z.enum(['cancelled', 'dead']),
    jobId: platformSecretRewrapJobIdSchema,
  })
  .strict();
export const adminSecretRotationRestartOutputSchema = adminSecretRotationJobSchema;

export type AdminSecretRotationCancelInput = z.input<typeof adminSecretRotationCancelInputSchema>;
export type AdminSecretRotationRestartInput = z.input<typeof adminSecretRotationRestartInputSchema>;
export type AdminSecretRotationRetryInput = z.input<typeof adminSecretRotationRetryInputSchema>;
export type AdminSecretRotationStartInput = z.input<typeof adminSecretRotationStartInputSchema>;
