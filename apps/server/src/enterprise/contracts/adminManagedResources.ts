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

/**
 * Immediate site-wide managed-resource policy write (de-drafted 统一管理 surface).
 * Collapses the former saveDraft + publish pair: `draft` is written and published in the
 * same transaction, so `expectedDraftToken` / `expectedRevision` guard one CAS base.
 */
export const adminManagedResourcesSaveInputSchema = z
  .object({
    comment: secretSafeOptionalCommentSchema,
    draft: managedResourcePolicyMapSchema,
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    reason: secretSafeAuditReasonSchema,
  })
  .strict();

export const adminManagedResourcesSaveOutputSchema = z
  .object({
    auditId: z.string().min(1),
    revision: z.number().int().positive(),
    /**
     * `pending_recovery` still means the policy COMMITTED — only the connector runtime
     * finalization needs lease self-healing. Never surface it as a failed save.
     */
    runtimeTransition: z.enum(['finalized', 'pending_recovery']),
  })
  .strict();

export type AdminManagedResourcesGetOutput = z.infer<typeof adminManagedResourcesGetOutputSchema>;
export type AdminManagedResourcesSaveInput = z.infer<typeof adminManagedResourcesSaveInputSchema>;
export type AdminManagedResourcesSaveOutput = z.infer<typeof adminManagedResourcesSaveOutputSchema>;
