import { z } from 'zod';

import { adminPlatformAgentDetailOutputSchema } from './adminLifecycle';
import { draftTokenSchema, idSchema, reasonSchema, revisionSchema } from './common';
import {
  platformAgentAssignmentSchema,
  platformAgentImmutableVersionSchema,
  platformAgentRolloutProjectionSchema,
} from './domain';

export const adminPlatformAgentRolloutStartInputSchema = z
  .object({
    agentId: idSchema,
    assignmentId: idSchema,
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    reason: reasonSchema,
  })
  .strict();

export const adminPlatformAgentRolloutListInputSchema = z
  .object({
    agentId: idSchema,
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const adminPlatformAgentRolloutListOutputSchema = z
  .object({
    items: z.array(platformAgentRolloutProjectionSchema).max(100),
    nextCursor: z.string().trim().min(1).max(512).nullable(),
  })
  .strict();

/**
 * The client-assembled Agent detail aggregate: the authoritative get output plus the fully-paged
 * assignments / rollouts / versions collections. Composed from the SAME contract schemas as the
 * individual paged endpoints (no field is weakened), so a refreshed detail can be validated as a
 * complete authoritative aggregate — full identity, draftToken, and every dependent collection —
 * before it is ever trusted to advance the optimistic-concurrency CAS or unlock a pending write.
 */
export const adminPlatformAgentDetailAggregateOutputSchema = adminPlatformAgentDetailOutputSchema
  .extend({
    assignments: z.array(platformAgentAssignmentSchema),
    rollouts: z.array(platformAgentRolloutProjectionSchema),
    versions: z.array(platformAgentImmutableVersionSchema),
  })
  .strict();

export const adminPlatformAgentRolloutGetInputSchema = z
  .object({
    agentId: idSchema,
    jobId: idSchema,
  })
  .strict();

const rolloutJobMutationBaseSchema = z
  .object({
    agentId: idSchema,
    expectedJobRevision: revisionSchema,
    jobId: idSchema,
    reason: reasonSchema,
  })
  .strict();

/** Cancel is only valid while the job is still queued or actively running. */
export const adminPlatformAgentRolloutCancelInputSchema = rolloutJobMutationBaseSchema
  .extend({
    expectedStatus: z.enum(['pending', 'running']),
  })
  .strict();

/** Retry is only valid from terminal failure-like states. */
export const adminPlatformAgentRolloutRetryInputSchema = rolloutJobMutationBaseSchema
  .extend({
    expectedStatus: z.enum(['cancelled', 'dead', 'failed']),
  })
  .strict();

/** Rollback is only valid after a completed (succeeded) rollout. */
export const adminPlatformAgentRolloutRollbackInputSchema = rolloutJobMutationBaseSchema
  .extend({
    expectedStatus: z.enum(['completed']),
    targetVersionId: idSchema,
  })
  .strict();

export const adminPlatformAgentRolloutOutputSchema = platformAgentRolloutProjectionSchema;
export const adminPlatformAgentRolloutStartOutputSchema = adminPlatformAgentRolloutOutputSchema;
export const adminPlatformAgentRolloutGetOutputSchema = adminPlatformAgentRolloutOutputSchema;
export const adminPlatformAgentRolloutCancelOutputSchema = adminPlatformAgentRolloutOutputSchema;
export const adminPlatformAgentRolloutRetryOutputSchema = adminPlatformAgentRolloutOutputSchema;
export const adminPlatformAgentRolloutRollbackOutputSchema = adminPlatformAgentRolloutOutputSchema;
