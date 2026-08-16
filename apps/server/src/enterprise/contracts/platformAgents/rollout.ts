import { z } from 'zod';

import { adminPlatformAgentDetailOutputSchema } from './adminLifecycle';
import { draftTokenSchema, idSchema, optionalReasonSchema, revisionSchema } from './common';
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
    reason: optionalReasonSchema,
  })
  .strict();

export const adminPlatformAgentRolloutListInputSchema = z
  .object({
    agentId: idSchema,
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    /**
     * Optional projection-status filter. When set, only jobs whose projected status is in this
     * set are returned (e.g. `['pending','running']` for active-job polling). Maps to persistence
     * statuses server-side (`pending` includes reserved; `completed` is succeeded).
     */
    status: z
      .array(z.enum(['cancelled', 'completed', 'dead', 'failed', 'pending', 'running']))
      .min(1)
      .max(6)
      .optional(),
  })
  .strict();

export const adminPlatformAgentRolloutListOutputSchema = z
  .object({
    items: z.array(platformAgentRolloutProjectionSchema).max(100),
    nextCursor: z.string().trim().min(1).max(512).nullable(),
  })
  .strict();

/**
 * Optional completeness metadata for client-assembled subcollections. When a page ceiling or
 * stuck cursor stops a drain short of the server catalog, these flags keep the operator from
 * treating a partial array as authoritative. Absent/undefined means "not reported" (legacy
 * fixtures); explicit `false` means the drain reached a terminal null cursor.
 */
export const adminAgentCollectionMetaSchema = z
  .object({
    assignmentsNextCursor: z.string().trim().min(1).max(512).nullable(),
    assignmentsTruncated: z.boolean(),
    rolloutsNextCursor: z.string().trim().min(1).max(512).nullable(),
    rolloutsTruncated: z.boolean(),
    versionsNextCursor: z.string().trim().min(1).max(512).nullable(),
    versionsTruncated: z.boolean(),
  })
  .strict();

/**
 * The client-assembled Agent detail aggregate: the authoritative get output plus the paged
 * assignments / rollouts / versions collections. Composed from the SAME contract schemas as the
 * individual paged endpoints (no field is weakened), so a refreshed detail can be validated as a
 * complete authoritative aggregate — full identity, draftToken, and every dependent collection —
 * before it is ever trusted to advance the optimistic-concurrency CAS or unlock a pending write.
 * Truncation metadata is optional so partial drains remain schema-valid while remaining visible.
 */
export const adminPlatformAgentDetailAggregateOutputSchema = adminPlatformAgentDetailOutputSchema
  .extend({
    assignments: z.array(platformAgentAssignmentSchema),
    collectionMeta: adminAgentCollectionMetaSchema.optional(),
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
    reason: optionalReasonSchema,
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
