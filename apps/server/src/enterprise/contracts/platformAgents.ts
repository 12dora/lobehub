import {
  PLATFORM_AGENT_ASSIGNMENT_MODES,
  PLATFORM_AGENT_ASSIGNMENT_TARGET_TYPES,
  PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY,
  PLATFORM_AGENT_GLOBAL_TARGET_ID,
  PLATFORM_AGENT_VERSION_POLICIES,
} from '@lobechat/types';
import semver from 'semver';
import { z } from 'zod';

import { containsEnterpriseSecretMaterial } from '../security/redaction';

const addSecretIssue = (value: string, ctx: z.RefinementCtx) => {
  if (containsEnterpriseSecretMaterial(value)) {
    ctx.addIssue({ code: 'custom', message: 'secret material is not allowed' });
  }
};

const safeText = (max: number, min = 0) =>
  z.string().trim().min(min).max(max).superRefine(addSecretIssue);

const idSchema = z.string().trim().min(1).max(128);
const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.number().int().nonnegative();
const positiveRevisionSchema = z.number().int().positive();
const reasonSchema = safeText(2000, 1);
const draftTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const platformAgentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const platformAgentVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => semver.valid(value) === value, 'version must be valid SemVer');

export const platformAgentSystemKeySchema = z
  .literal(PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY)
  .nullable();

export const platformAgentModelParametersSchema = z
  .object({
    frequencyPenalty: z.number().finite().min(-2).max(2).optional(),
    maxTokens: z.number().int().positive().max(10_000_000).optional(),
    presencePenalty: z.number().finite().min(-2).max(2).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    topP: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

const uniqueStringsSchema = (item: z.ZodType<string>, max: number) =>
  z
    .array(item)
    .max(max)
    .superRefine((values, ctx) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: 'custom', message: 'values must be unique' });
      }
    });

export const platformAgentVersionConfigSchema = z
  .object({
    avatar: safeText(2048, 1).nullable(),
    backgroundColor: z
      .string()
      .trim()
      .regex(/^#[a-f0-9]{6}$/i)
      .nullable(),
    description: safeText(4000, 1).nullable(),
    displayName: safeText(200, 1),
    modelParameters: platformAgentModelParametersSchema,
    openingMessage: safeText(8000, 1).nullable(),
    openingQuestions: uniqueStringsSchema(safeText(1000, 1), 50),
    systemRole: safeText(100_000, 1),
    tags: uniqueStringsSchema(safeText(100, 1), 50),
  })
  .strict();

export const platformAgentModelDependencyRefSchema = z
  .object({
    modelKey: safeText(150, 1),
    providerChecksum: checksumSchema,
    providerKey: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    providerRevision: positiveRevisionSchema,
  })
  .strict();

export const platformAgentSkillDependencyRefSchema = z
  .object({
    checksum: checksumSchema,
    skillKey: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    version: platformAgentVersionSchema,
  })
  .strict();

const connectorToolKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][\w.:/-]{0,199}$/u);

export const platformAgentConnectorDependencyRefSchema = z
  .object({
    allowedToolKeys: uniqueStringsSchema(connectorToolKeySchema, 1000),
    connectorId: idSchema,
    connectorKey: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    publishedChecksum: checksumSchema,
    publishedRevision: positiveRevisionSchema,
  })
  .strict();

export const platformAgentDependencySnapshotSchema = z
  .object({
    connectors: z.array(platformAgentConnectorDependencyRefSchema).max(100),
    model: platformAgentModelDependencyRefSchema,
    skills: z.array(platformAgentSkillDependencyRefSchema).max(100),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const connectorKeys = snapshot.connectors.map(({ connectorKey }) => connectorKey);
    if (new Set(connectorKeys).size !== connectorKeys.length) {
      ctx.addIssue({ code: 'custom', message: 'connector references must be unique' });
    }
    const skillKeys = snapshot.skills.map(({ skillKey }) => skillKey);
    if (new Set(skillKeys).size !== skillKeys.length) {
      ctx.addIssue({ code: 'custom', message: 'skill references must be unique' });
    }
  });

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
    status: z.enum(['cancelled', 'completed', 'dead', 'failed', 'pending', 'running']),
    total: z.number().int().nonnegative(),
    updatedAt: z.date(),
  })
  .strict()
  .refine(({ completed, failed, total }) => completed + failed <= total, {
    message: 'rollout counters exceed total',
  });

export const platformUserAgentMaterializationSchema = z
  .object({
    materializedAgentId: idSchema.nullable(),
    platformAgentId: idSchema,
    platformAgentVersionId: idSchema,
    userId: idSchema,
  })
  .strict();

export const adminPlatformAgentCreateInputSchema = z
  .object({
    agentKey: platformAgentKeySchema,
    isDefault: z.boolean().default(false),
    reason: reasonSchema,
    systemKey: platformAgentSystemKeySchema.default(null),
  })
  .strict()
  .superRefine((identity, ctx) => {
    if (identity.isDefault !== (identity.systemKey === PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY)) {
      ctx.addIssue({ code: 'custom', message: 'default Agent and system key must agree' });
    }
  });

export const adminPlatformAgentListInputSchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    query: safeText(200, 1).optional(),
    status: z.enum(['archived', 'draft', 'published']).optional(),
  })
  .strict();

export const adminPlatformAgentListItemSchema = z
  .object({
    assignmentCount: z.number().int().nonnegative(),
    displayName: safeText(200, 1),
    identity: platformAgentIdentityDraftSchema,
    publishedVersion: platformAgentVersionSchema.nullable(),
  })
  .strict();

export const adminPlatformAgentListOutputSchema = z
  .object({
    items: z.array(adminPlatformAgentListItemSchema).max(100),
    nextCursor: z.string().trim().min(1).max(512).nullable(),
  })
  .strict();

export const adminPlatformAgentGetInputSchema = z.object({ id: idSchema }).strict();

export const adminPlatformAgentDetailOutputSchema = z
  .object({
    assignments: z.array(platformAgentAssignmentSchema).max(1000),
    draftToken: draftTokenSchema,
    identity: platformAgentIdentityDraftSchema,
    rollouts: z.array(platformAgentRolloutProjectionSchema).max(1000),
    versions: z.array(platformAgentImmutableVersionSchema).max(1000),
  })
  .strict();

export const adminPlatformAgentMutationOutputSchema = z
  .object({
    draftToken: draftTokenSchema,
    identity: platformAgentIdentityDraftSchema,
  })
  .strict();

export const adminPlatformAgentCreateOutputSchema = adminPlatformAgentMutationOutputSchema;
export const adminPlatformAgentUpdateDraftOutputSchema = adminPlatformAgentMutationOutputSchema;

export const adminPlatformAgentUpdateDraftInputSchema = z
  .object({
    agentId: idSchema,
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    isDefault: z.boolean().optional(),
    reason: reasonSchema,
    systemKey: platformAgentSystemKeySchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.isDefault === undefined && input.systemKey === undefined) {
      ctx.addIssue({ code: 'custom', message: 'at least one draft field is required' });
    }
    if (
      input.isDefault !== undefined &&
      input.systemKey !== undefined &&
      input.isDefault !== (input.systemKey === PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY)
    ) {
      ctx.addIssue({ code: 'custom', message: 'default Agent and system key must agree' });
    }
  });

export const adminPlatformAgentAppendVersionInputSchema = z
  .object({
    agentId: idSchema,
    config: platformAgentVersionConfigSchema,
    dependencySnapshot: platformAgentDependencySnapshotSchema,
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    reason: reasonSchema,
    version: platformAgentVersionSchema,
  })
  .strict();

export const adminPlatformAgentPublishInputSchema =
  adminPlatformAgentAppendVersionInputSchema.strict();

export const adminPlatformAgentAppendVersionOutputSchema = z
  .object({
    draftToken: draftTokenSchema,
    identity: platformAgentIdentityDraftSchema,
    version: platformAgentImmutableVersionSchema,
  })
  .strict();

export const adminPlatformAgentRollbackInputSchema = z
  .object({
    agentId: idSchema,
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    reason: reasonSchema,
    targetVersionId: idSchema,
  })
  .strict();

export const platformAgentDependencyValidationOutputSchema = z
  .object({ valid: z.literal(true) })
  .strict();

export const platformAgentPublicationOutputSchema = z
  .object({
    agentId: idSchema,
    revision: positiveRevisionSchema,
    versionId: idSchema,
  })
  .strict();

export const adminPlatformAgentArchiveInputSchema = z
  .object({
    agentId: idSchema,
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    reason: reasonSchema,
  })
  .strict();

export const adminPlatformAgentArchiveOutputSchema = adminPlatformAgentMutationOutputSchema;

export const adminPlatformAgentDependentSchema = z
  .object({
    id: idSchema,
    key: safeText(256, 1),
    name: safeText(256, 1),
    type: z.enum(['assignment', 'materialization']),
    version: platformAgentVersionSchema.nullable(),
  })
  .strict();

export const adminPlatformAgentDependentsInputSchema = z
  .object({
    agentId: idSchema,
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const adminPlatformAgentDependentsOutputSchema = z
  .object({
    items: z.array(adminPlatformAgentDependentSchema).max(100),
    nextCursor: z.string().trim().min(1).max(512).nullable(),
  })
  .strict();

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

export const adminPlatformAgentAssignmentListInputSchema = z.object({ agentId: idSchema }).strict();

export const adminPlatformAgentAssignmentListOutputSchema = z
  .object({ items: z.array(platformAgentAssignmentSchema).max(1000) })
  .strict();

export const adminPlatformAgentAssignmentUpsertInputSchema = z
  .object({
    agentId: idSchema,
    assignmentId: idSchema.optional(),
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

export const adminPlatformAgentAssignmentRemoveInputSchema = z
  .object({
    agentId: idSchema,
    assignmentId: idSchema,
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

export const adminPlatformAgentRolloutStartInputSchema = z
  .object({
    agentId: idSchema,
    assignmentId: idSchema,
    reason: reasonSchema,
  })
  .strict();

export const adminPlatformAgentRolloutGetInputSchema = z
  .object({
    agentId: idSchema,
    jobId: idSchema,
  })
  .strict();

export const adminPlatformAgentRolloutMutationInputSchema = z
  .object({
    agentId: idSchema,
    jobId: idSchema,
    reason: reasonSchema,
  })
  .strict();

export const adminPlatformAgentRolloutCancelInputSchema =
  adminPlatformAgentRolloutMutationInputSchema;
export const adminPlatformAgentRolloutRetryInputSchema =
  adminPlatformAgentRolloutMutationInputSchema;

export const adminPlatformAgentRolloutRollbackInputSchema = z
  .object({
    agentId: idSchema,
    jobId: idSchema,
    reason: reasonSchema,
    targetVersionId: idSchema,
  })
  .strict();

export const adminPlatformAgentRolloutOutputSchema = platformAgentRolloutProjectionSchema;
export const adminPlatformAgentRolloutStartOutputSchema = adminPlatformAgentRolloutOutputSchema;
export const adminPlatformAgentRolloutGetOutputSchema = adminPlatformAgentRolloutOutputSchema;
export const adminPlatformAgentRolloutCancelOutputSchema = adminPlatformAgentRolloutOutputSchema;
export const adminPlatformAgentRolloutRetryOutputSchema = adminPlatformAgentRolloutOutputSchema;
export const adminPlatformAgentRolloutRollbackOutputSchema = adminPlatformAgentRolloutOutputSchema;

export const platformAgentEffectiveListOutputSchema = z
  .object({ agents: z.array(platformEffectiveAgentSchema).max(1000), revision: checksumSchema })
  .strict();

export const platformAgentEffectiveGetInputSchema = z
  .object({ platformAgentId: idSchema })
  .strict();

export const platformAgentEffectiveGetOutputSchema = platformEffectiveAgentSchema.nullable();

export const adminPlatformAgentValidateDependenciesInputSchema = z
  .object({ dependencySnapshot: platformAgentDependencySnapshotSchema })
  .strict();

export type AdminPlatformAgentAppendVersionInput = z.infer<
  typeof adminPlatformAgentAppendVersionInputSchema
>;
export type AdminPlatformAgentAssignmentCreateInput = z.infer<
  typeof adminPlatformAgentAssignmentCreateInputSchema
>;
export type AdminPlatformAgentCreateInput = z.infer<typeof adminPlatformAgentCreateInputSchema>;
export type AdminPlatformAgentPublishInput = z.infer<typeof adminPlatformAgentPublishInputSchema>;
export type AdminPlatformAgentRollbackInput = z.infer<typeof adminPlatformAgentRollbackInputSchema>;
export type AdminPlatformAgentArchiveInput = z.infer<typeof adminPlatformAgentArchiveInputSchema>;
export type AdminPlatformAgentAppendVersionOutput = z.infer<
  typeof adminPlatformAgentAppendVersionOutputSchema
>;
export type AdminPlatformAgentAssignmentListInput = z.infer<
  typeof adminPlatformAgentAssignmentListInputSchema
>;
export type AdminPlatformAgentAssignmentListOutput = z.infer<
  typeof adminPlatformAgentAssignmentListOutputSchema
>;
export type AdminPlatformAgentAssignmentPreviewInput = z.infer<
  typeof adminPlatformAgentAssignmentPreviewInputSchema
>;
export type AdminPlatformAgentAssignmentPreviewOutput = z.infer<
  typeof adminPlatformAgentAssignmentPreviewOutputSchema
>;
export type AdminPlatformAgentAssignmentRemoveInput = z.infer<
  typeof adminPlatformAgentAssignmentRemoveInputSchema
>;
export type AdminPlatformAgentAssignmentRemoveOutput = z.infer<
  typeof adminPlatformAgentAssignmentRemoveOutputSchema
>;
export type AdminPlatformAgentAssignmentUpsertInput = z.infer<
  typeof adminPlatformAgentAssignmentUpsertInputSchema
>;
export type AdminPlatformAgentDependentsInput = z.infer<
  typeof adminPlatformAgentDependentsInputSchema
>;
export type AdminPlatformAgentDependentsOutput = z.infer<
  typeof adminPlatformAgentDependentsOutputSchema
>;
export type AdminPlatformAgentDetailOutput = z.infer<typeof adminPlatformAgentDetailOutputSchema>;
export type AdminPlatformAgentGetInput = z.infer<typeof adminPlatformAgentGetInputSchema>;
export type AdminPlatformAgentListInput = z.infer<typeof adminPlatformAgentListInputSchema>;
export type AdminPlatformAgentListOutput = z.infer<typeof adminPlatformAgentListOutputSchema>;
export type AdminPlatformAgentMutationOutput = z.infer<
  typeof adminPlatformAgentMutationOutputSchema
>;
export type AdminPlatformAgentRolloutGetInput = z.infer<
  typeof adminPlatformAgentRolloutGetInputSchema
>;
export type AdminPlatformAgentRolloutCancelInput = z.infer<
  typeof adminPlatformAgentRolloutCancelInputSchema
>;
export type AdminPlatformAgentRolloutMutationInput = z.infer<
  typeof adminPlatformAgentRolloutMutationInputSchema
>;
export type AdminPlatformAgentRolloutRetryInput = z.infer<
  typeof adminPlatformAgentRolloutRetryInputSchema
>;
export type AdminPlatformAgentRolloutRollbackInput = z.infer<
  typeof adminPlatformAgentRolloutRollbackInputSchema
>;
export type AdminPlatformAgentRolloutStartInput = z.infer<
  typeof adminPlatformAgentRolloutStartInputSchema
>;
export type AdminPlatformAgentUpdateDraftInput = z.infer<
  typeof adminPlatformAgentUpdateDraftInputSchema
>;
export type PlatformAgentEffectiveGetInput = z.infer<typeof platformAgentEffectiveGetInputSchema>;
export type PlatformAgentEffectiveGetOutput = z.infer<typeof platformAgentEffectiveGetOutputSchema>;
export type PlatformAgentEffectiveListOutput = z.infer<
  typeof platformAgentEffectiveListOutputSchema
>;
