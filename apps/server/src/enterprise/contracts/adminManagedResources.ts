import { z } from 'zod';

export const managedResourceEnforcementModeSchema = z.enum(['observe', 'ui-only', 'enforced']);

export const managedResourcePolicyItemSchema = z
  .object({
    enforcementMode: managedResourceEnforcementModeSchema,
    managed: z.boolean(),
  })
  .strict();

export const managedResourcePolicyMapSchema = z
  .object({
    agents: managedResourcePolicyItemSchema,
    aiModels: managedResourcePolicyItemSchema,
    aiProviders: managedResourcePolicyItemSchema,
    connectors: managedResourcePolicyItemSchema,
    skills: managedResourcePolicyItemSchema,
  })
  .strict();

export const managedResourceReadinessMapSchema = z
  .object({
    agents: z.boolean(),
    aiModels: z.boolean(),
    aiProviders: z.boolean(),
    connectors: z.boolean(),
    skills: z.boolean(),
  })
  .strict();

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
    reason: z.string().trim().min(1).max(2000),
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
    comment: z.string().trim().min(1).max(2000).optional(),
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const adminManagedResourcesPublishOutputSchema = z
  .object({
    auditId: z.string().min(1),
    revision: z.number().int().positive(),
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
