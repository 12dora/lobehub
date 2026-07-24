import { z } from 'zod';

import { sidebarLayoutConfigSchema } from '@/types/platform/sidebarLayout';

/**
 * Platform sidebar-layout admin contracts (direct-save + CAS).
 *
 * Flat document shape: layout fields + CAS revision token. Writers must supply
 * `expectedRevision` matching the last-loaded `revision`; the server advances
 * revision only on a successful conditional update.
 */

const sidebarLayoutFields = {
  layout: sidebarLayoutConfigSchema.nullable(),
  mode: z.enum(['platform', 'user']),
} as const;

/** Full platform sidebar-layout document including CAS revision. */
export const adminSidebarLayoutGetOutputSchema = z
  .object({
    ...sidebarLayoutFields,
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type AdminSidebarLayoutGetOutput = z.infer<typeof adminSidebarLayoutGetOutputSchema>;

/** Full-document update with CAS expectedRevision. */
export const adminSidebarLayoutUpdateInputSchema = z
  .object({
    ...sidebarLayoutFields,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export type AdminSidebarLayoutUpdateInput = z.infer<typeof adminSidebarLayoutUpdateInputSchema>;

export const adminSidebarLayoutUpdateOutputSchema = adminSidebarLayoutGetOutputSchema;
export type AdminSidebarLayoutUpdateOutput = z.infer<typeof adminSidebarLayoutUpdateOutputSchema>;
