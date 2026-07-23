import {
  PLATFORM_AGENT_ASSIGNMENT_MODES,
  PLATFORM_AGENT_ASSIGNMENT_TARGET_TYPES,
  PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY,
  PLATFORM_AGENT_GLOBAL_TARGET_ID,
  PLATFORM_AGENT_VERSION_POLICIES,
} from '@lobechat/types';
import { z } from 'zod';

import {
  checksumSchema,
  idSchema,
  platformAgentDependencySnapshotSchema,
  platformAgentKeySchema,
  platformAgentSystemKeySchema,
  platformAgentVersionConfigSchema,
  platformAgentVersionSchema,
  revisionSchema,
} from './common';

export const platformAgentIdentityDraftSchema = z
  .object({
    agentKey: platformAgentKeySchema,
    currentVersionId: idSchema.nullable(),
    draftSequence: revisionSchema,
    id: idSchema,
    isDefault: z.boolean(),
    migrationRequired: z.boolean(),
    revision: revisionSchema,
    status: z.enum(['archived', 'draft', 'published']),
    systemKey: platformAgentSystemKeySchema,
  })
  .strict()
  .superRefine((identity, ctx) => {
    if (identity.isDefault !== (identity.systemKey === PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY)) {
      ctx.addIssue({ code: 'custom', message: 'default Agent and system key must agree' });
    }
    if (identity.status === 'published' && identity.currentVersionId === null) {
      ctx.addIssue({ code: 'custom', message: 'published Agent requires a version pointer' });
    }
  });

export const platformAgentImmutableVersionSchema = z
  .object({
    agentId: idSchema,
    checksum: checksumSchema,
    config: platformAgentVersionConfigSchema,
    createdAt: z.date(),
    createdBy: idSchema.nullable(),
    dependencySnapshot: platformAgentDependencySnapshotSchema,
    id: idSchema,
    version: platformAgentVersionSchema,
  })
  .strict();

export const platformAgentAssignmentSchema = z
  .object({
    agentId: idSchema,
    enabled: z.boolean(),
    id: idSchema,
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

export const platformEffectiveAgentSchema = z
  .object({
    agentKey: platformAgentKeySchema,
    checksum: checksumSchema,
    config: platformAgentVersionConfigSchema,
    distribution: z.enum(PLATFORM_AGENT_ASSIGNMENT_MODES),
    mutable: z.literal(false),
    platformAgentId: idSchema,
    source: z.literal('platform'),
    systemKey: platformAgentSystemKeySchema,
    version: platformAgentVersionSchema,
    versionId: idSchema,
  })
  .strict();

export const platformAgentRolloutProjectionSchema = z
  .object({
    assignmentId: idSchema,
    completed: z.number().int().nonnegative(),
    cursor: z.string().min(1).max(1000).nullable(),
    failed: z.number().int().nonnegative(),
    jobId: idSchema,
    previousVersionId: idSchema.nullable(),
    revision: revisionSchema,
    status: z.enum(['cancelled', 'completed', 'dead', 'failed', 'pending', 'running']),
    targetVersionId: idSchema,
    total: z.number().int().nonnegative(),
    updatedAt: z.date(),
  })
  .strict()
  .refine(({ completed, failed, total }) => completed + failed <= total, {
    message: 'rollout counters exceed total',
  });
