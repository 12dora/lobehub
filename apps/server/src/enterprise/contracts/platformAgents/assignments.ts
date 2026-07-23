import { z } from 'zod';

import {
  platformAgentAssignmentCoreFields,
  platformAgentAssignmentCoreSchema,
  refinePlatformAgentAssignmentInvariants,
} from './assignmentCore';
import { draftTokenSchema, idSchema, reasonSchema, revisionSchema, safeText } from './common';
import { platformAgentAssignmentSchema } from './domain';

export {
  type PlatformAgentAssignmentCore,
  platformAgentAssignmentCoreFields,
  platformAgentAssignmentCoreSchema,
  refinePlatformAgentAssignmentInvariants,
} from './assignmentCore';

export const adminPlatformAgentAssignmentListInputSchema = z
  .object({
    agentId: idSchema,
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const adminPlatformAgentAssignmentListOutputSchema = z
  .object({
    items: z.array(platformAgentAssignmentSchema).max(100),
    nextCursor: z.string().trim().min(1).max(512).nullable(),
  })
  .strict();

export const adminPlatformAgentAssignmentUpsertInputSchema = z
  .object({
    agentId: idSchema,
    assignmentId: idSchema.optional(),
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    reason: reasonSchema,
    ...platformAgentAssignmentCoreFields,
  })
  .strict()
  .superRefine(refinePlatformAgentAssignmentInvariants);

export const adminPlatformAgentAssignmentRemoveInputSchema = z
  .object({
    agentId: idSchema,
    assignmentId: idSchema,
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    reason: reasonSchema,
  })
  .strict();

export const adminPlatformAgentAssignmentRemoveOutputSchema = z
  .object({ removed: z.literal(true) })
  .strict();

export const adminPlatformAgentAssignmentUpsertOutputSchema = platformAgentAssignmentSchema;

export const adminPlatformAgentAssignmentPreviewInputSchema = z
  .object({
    agentId: idSchema,
    assignment: platformAgentAssignmentCoreSchema,
  })
  .strict();

export const adminPlatformAgentAssignmentPreviewOutputSchema = z
  .object({
    estimatedUsers: z.number().int().nonnegative(),
    warnings: z.array(safeText(500, 1)).max(50),
  })
  .strict();
