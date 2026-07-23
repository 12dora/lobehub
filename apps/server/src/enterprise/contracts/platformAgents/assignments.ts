import {
  PLATFORM_AGENT_ASSIGNMENT_MODES,
  PLATFORM_AGENT_ASSIGNMENT_TARGET_TYPES,
  PLATFORM_AGENT_GLOBAL_TARGET_ID,
  PLATFORM_AGENT_VERSION_POLICIES,
} from '@lobechat/types';
import { z } from 'zod';

import { draftTokenSchema, idSchema, reasonSchema, revisionSchema, safeText } from './common';
import { platformAgentAssignmentSchema } from './domain';

export const adminPlatformAgentAssignmentCreateInputSchema = z
  .object({
    agentId: idSchema,
    enabled: z.boolean(),
    mode: z.enum(PLATFORM_AGENT_ASSIGNMENT_MODES),
    pinnedVersionId: idSchema.nullable(),
    reason: reasonSchema,
    targetId: idSchema,
    targetType: z.enum(PLATFORM_AGENT_ASSIGNMENT_TARGET_TYPES),
    versionPolicy: z.enum(PLATFORM_AGENT_VERSION_POLICIES),
  })
  .strict()
  .superRefine((assignment, ctx) => {
    if (
      (assignment.targetType === 'global') !==
      (assignment.targetId === PLATFORM_AGENT_GLOBAL_TARGET_ID)
    ) {
      ctx.addIssue({ code: 'custom', message: 'global assignment target is invalid' });
    }
    if ((assignment.versionPolicy === 'pinned') !== (assignment.pinnedVersionId !== null)) {
      ctx.addIssue({ code: 'custom', message: 'pinned policy requires exactly one version' });
    }
  });

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
    enabled: z.boolean(),
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    mode: z.enum(PLATFORM_AGENT_ASSIGNMENT_MODES),
    pinnedVersionId: idSchema.nullable(),
    reason: reasonSchema,
    targetId: idSchema,
    targetType: z.enum(PLATFORM_AGENT_ASSIGNMENT_TARGET_TYPES),
    versionPolicy: z.enum(PLATFORM_AGENT_VERSION_POLICIES),
  })
  .strict()
  .superRefine((assignment, ctx) => {
    if (
      (assignment.targetType === 'global') !==
      (assignment.targetId === PLATFORM_AGENT_GLOBAL_TARGET_ID)
    ) {
      ctx.addIssue({ code: 'custom', message: 'global assignment target is invalid' });
    }
    if ((assignment.versionPolicy === 'pinned') !== (assignment.pinnedVersionId !== null)) {
      ctx.addIssue({ code: 'custom', message: 'pinned policy requires exactly one version' });
    }
  });

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

const platformAgentAssignmentPreviewDraftSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(PLATFORM_AGENT_ASSIGNMENT_MODES),
    pinnedVersionId: idSchema.nullable(),
    targetId: idSchema,
    targetType: z.enum(PLATFORM_AGENT_ASSIGNMENT_TARGET_TYPES),
    versionPolicy: z.enum(PLATFORM_AGENT_VERSION_POLICIES),
  })
  .strict()
  .superRefine((assignment, ctx) => {
    if (
      (assignment.targetType === 'global') !==
      (assignment.targetId === PLATFORM_AGENT_GLOBAL_TARGET_ID)
    ) {
      ctx.addIssue({ code: 'custom', message: 'global assignment target is invalid' });
    }
    if ((assignment.versionPolicy === 'pinned') !== (assignment.pinnedVersionId !== null)) {
      ctx.addIssue({ code: 'custom', message: 'pinned policy requires exactly one version' });
    }
  });

export const adminPlatformAgentAssignmentPreviewInputSchema = z
  .object({
    agentId: idSchema,
    assignment: platformAgentAssignmentPreviewDraftSchema,
  })
  .strict();

export const adminPlatformAgentAssignmentPreviewOutputSchema = z
  .object({
    estimatedUsers: z.number().int().nonnegative(),
    warnings: z.array(safeText(500, 1)).max(50),
  })
  .strict();
