import { z } from 'zod';

import {
  MANAGED_RESOURCE_ENFORCEMENT_MODES,
  MANAGED_RESOURCE_KINDS,
  type ManagedResourceKind,
} from '@/const/platform/managedResources';

import { secretSafeAuditReasonSchema, secretSafeOptionalCommentSchema } from './shared';

export const managedResourceEnforcementModeSchema = z.enum(MANAGED_RESOURCE_ENFORCEMENT_MODES);

export const managedResourcePolicyItemSchema = z
  .object({
    enforcementMode: managedResourceEnforcementModeSchema,
    managed: z.boolean(),
  })
  .strict();

const managedResourceMapShape = Object.fromEntries(
  MANAGED_RESOURCE_KINDS.map((kind) => [kind, managedResourcePolicyItemSchema]),
) as Record<ManagedResourceKind, typeof managedResourcePolicyItemSchema>;

const managedResourceReadinessShape = Object.fromEntries(
  MANAGED_RESOURCE_KINDS.map((kind) => [kind, z.boolean()]),
) as Record<ManagedResourceKind, z.ZodBoolean>;

export const managedResourcePolicyMapSchema = z.object(managedResourceMapShape).strict();

export const managedResourceReadinessMapSchema = z.object(managedResourceReadinessShape).strict();

export const adminManagedResourcesGetOutputSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    draft: managedResourcePolicyMapSchema,
    draftToken: z.string().length(64),
    published: managedResourcePolicyMapSchema,
    readiness: managedResourceReadinessMapSchema,
    status: z.enum(['draft', 'published']),
  })
  .strict();

export const adminManagedResourcesSaveDraftInputSchema = z
  .object({
    draft: managedResourcePolicyMapSchema,
    expectedDraftToken: z.string().length(64),
    reason: secretSafeAuditReasonSchema,
  })
  .strict();

export const adminManagedResourcesSaveDraftOutputSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    draftToken: z.string().length(64),
    ok: z.literal(true),
  })
  .strict();

export const adminManagedResourcesPublishInputSchema = z
  .object({
    comment: secretSafeOptionalCommentSchema,
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    reason: secretSafeAuditReasonSchema,
  })
  .strict();

export const adminManagedResourcesPublishOutputSchema = z
  .object({
    auditId: z.string().min(1),
    revision: z.number().int().positive(),
    runtimeTransition: z.enum(['finalized', 'pending_recovery']),
  })
  .strict();

export type AdminManagedResourcesGetOutput = z.infer<typeof adminManagedResourcesGetOutputSchema>;
export type AdminManagedResourcesSaveDraftInput = z.infer<
  typeof adminManagedResourcesSaveDraftInputSchema
>;
export type AdminManagedResourcesSaveDraftOutput = z.infer<
  typeof adminManagedResourcesSaveDraftOutputSchema
>;
export type AdminManagedResourcesPublishInput = z.infer<
  typeof adminManagedResourcesPublishInputSchema
>;
export type AdminManagedResourcesPublishOutput = z.infer<
  typeof adminManagedResourcesPublishOutputSchema
>;
