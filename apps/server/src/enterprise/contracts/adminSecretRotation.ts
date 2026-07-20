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

export type AdminSecretRotationCancelInput = z.input<typeof adminSecretRotationCancelInputSchema>;
export type AdminSecretRotationRetryInput = z.input<typeof adminSecretRotationRetryInputSchema>;
export type AdminSecretRotationStartInput = z.input<typeof adminSecretRotationStartInputSchema>;
