import { z } from 'zod';

import {
  platformAgentAssignmentCoreFields,
  platformAgentAssignmentCoreSchema,
  refinePlatformAgentAssignmentInvariants,
} from './assignmentCore';
import { draftTokenSchema, idSchema, optionalReasonSchema, revisionSchema } from './common';
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
    reason: optionalReasonSchema,
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
    reason: optionalReasonSchema,
  })
  .strict();

export const adminPlatformAgentAssignmentRemoveOutputSchema = z
  .object({ removed: z.literal(true) })
  .strict();

export const adminPlatformAgentAssignmentUpsertOutputSchema = platformAgentAssignmentSchema;

/** Stable i18n warning codes returned by assignment preview (client key: agentCatalog.assignment.warning.*). */
export const PLATFORM_AGENT_ASSIGNMENT_WARNING_CODES = [
  'ASSIGNMENT_DISABLED',
  'MANDATORY_AGENT_CANNOT_BE_HIDDEN',
] as const;

export type PlatformAgentAssignmentWarningCode =
  (typeof PLATFORM_AGENT_ASSIGNMENT_WARNING_CODES)[number];

export const platformAgentAssignmentWarningCodeSchema = z.enum(
  PLATFORM_AGENT_ASSIGNMENT_WARNING_CODES,
);

export const adminPlatformAgentAssignmentPreviewInputSchema = z
  .object({
    agentId: idSchema,
    assignment: platformAgentAssignmentCoreSchema,
  })
  .strict();

export const adminPlatformAgentAssignmentPreviewOutputSchema = z
  .object({
    estimatedUsers: z.number().int().nonnegative(),
    warnings: z.array(platformAgentAssignmentWarningCodeSchema).max(50),
  })
  .strict();
