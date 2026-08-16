import { PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY } from '@lobechat/types';
import { z } from 'zod';

import {
  draftTokenSchema,
  idSchema,
  optionalReasonSchema,
  platformAgentDependencySnapshotSchema,
  platformAgentKeySchema,
  platformAgentSystemKeySchema,
  platformAgentVersionConfigSchema,
  platformAgentVersionSchema,
  positiveRevisionSchema,
  reasonSchema,
  revisionSchema,
  safeText,
} from './common';
import { platformAgentIdentityDraftSchema, platformAgentImmutableVersionSchema } from './domain';

/**
 * De-drafted write: append an immutable version AND publish it in one transaction. The
 * version label is server-generated (first `1.0.0`, then a patch bump of the latest one),
 * so clients never negotiate version numbers.
 */
export const adminPlatformAgentSaveInputSchema = z
  .object({
    agentId: idSchema,
    config: platformAgentVersionConfigSchema,
    dependencySnapshot: platformAgentDependencySnapshotSchema,
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    reason: optionalReasonSchema,
  })
  .strict();

export const adminPlatformAgentSaveOutputSchema = z
  .object({
    draftToken: draftTokenSchema,
    /** Always `status === 'published'` after a successful save. */
    identity: platformAgentIdentityDraftSchema,
    invalidationStatus: z.enum(['deferred', 'delivered']),
    /** The version created by this save — already the published pointer target. */
    version: platformAgentImmutableVersionSchema,
  })
  .strict();

/**
 * Create = create + publish live in one transaction, so the payload carries the full
 * config / dependency snapshot and the result is an already-published agent.
 */
export const adminPlatformAgentCreateInputSchema = z
  .object({
    agentKey: platformAgentKeySchema,
    config: platformAgentVersionConfigSchema,
    dependencySnapshot: platformAgentDependencySnapshotSchema,
    isDefault: z.boolean().default(false),
    reason: optionalReasonSchema,
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
    /**
     * Dedicated default-inbox pointer read. When true, returns at most the current default
     * Agent (O(1) index lookup path) so clients never page-walk the catalog to find it.
     */
    isDefault: z.boolean().optional(),
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
    draftToken: draftTokenSchema,
    identity: platformAgentIdentityDraftSchema,
  })
  .strict();

export const adminPlatformAgentGetOutputSchema = adminPlatformAgentDetailOutputSchema;

export const adminPlatformAgentMutationOutputSchema = z
  .object({
    draftToken: draftTokenSchema,
    identity: platformAgentIdentityDraftSchema,
  })
  .strict();

/** Create publishes, so it returns exactly what `save` returns. */
export const adminPlatformAgentCreateOutputSchema = adminPlatformAgentSaveOutputSchema;

export const adminPlatformAgentRollbackInputSchema = z
  .object({
    agentId: idSchema,
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    reason: optionalReasonSchema,
    targetVersionId: idSchema,
  })
  .strict();

export const platformAgentDependencyValidationOutputSchema = z
  .object({ valid: z.literal(true) })
  .strict();

export const platformAgentPublicationOutputSchema = z
  .object({
    agentId: idSchema,
    invalidationStatus: z.enum(['deferred', 'delivered']),
    revision: positiveRevisionSchema,
    versionId: idSchema,
  })
  .strict();

export const adminPlatformAgentRollbackOutputSchema = platformAgentPublicationOutputSchema;

export const adminPlatformAgentArchiveInputSchema = z
  .object({
    agentId: idSchema,
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    reason: reasonSchema,
    replacementAgentId: idSchema.nullable(),
  })
  .strict();

export const adminPlatformAgentArchiveOutputSchema = adminPlatformAgentMutationOutputSchema;

/**
 * Hard-delete a platform agent and every row it owns. Full identity CAS is required: revision
 * alone misses draftSequence/assignment mutations that advance the draft token without bumping
 * revision. Default / system agents are refused server-side (reassign via setDefaultInbox first).
 */
export const adminPlatformAgentDeleteInputSchema = z
  .object({
    agentId: idSchema,
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    reason: reasonSchema,
  })
  .strict();

export const adminPlatformAgentDeleteOutputSchema = z.object({ deleted: z.literal(true) }).strict();

const platformAgentPointerCasSchema = z
  .object({
    agentId: idSchema,
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

export const adminPlatformAgentSetDefaultInboxInputSchema = z
  .object({
    currentDefault: platformAgentPointerCasSchema.nullable(),
    nextDefault: platformAgentPointerCasSchema,
    reason: optionalReasonSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.currentDefault?.agentId === input.nextDefault.agentId) {
      ctx.addIssue({ code: 'custom', message: 'replacement default Agent must be different' });
    }
  });

export const adminPlatformAgentSetDefaultInboxOutputSchema = z
  .object({
    currentDefault: adminPlatformAgentMutationOutputSchema.nullable(),
    nextDefault: adminPlatformAgentMutationOutputSchema,
  })
  .strict();

export const adminPlatformAgentVersionsListInputSchema = z
  .object({
    agentId: idSchema,
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const adminPlatformAgentVersionsListOutputSchema = z
  .object({
    items: z.array(platformAgentImmutableVersionSchema).max(100),
    nextCursor: z.string().trim().min(1).max(512).nullable(),
  })
  .strict();

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

export const adminPlatformAgentValidateDependenciesInputSchema = z
  .object({ dependencySnapshot: platformAgentDependencySnapshotSchema })
  .strict();

export const adminPlatformAgentValidateDependenciesOutputSchema =
  platformAgentDependencyValidationOutputSchema;
