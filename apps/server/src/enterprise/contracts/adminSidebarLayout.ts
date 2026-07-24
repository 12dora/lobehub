import { z } from 'zod';

import { sidebarLayoutConfigSchema } from '@/types/platform/sidebarLayout';

/**
 * Platform sidebar-layout admin contracts (direct-save).
 *
 * Flat document shape: layout fields only. No CAS revision — the
 * `platform_sidebar_layout` table/model has no revision column. Lost-update
 * protection (expectedRevision / revision) is a known follow-up; do not re-add
 * wire fields until server-side CAS is implemented.
 */

const sidebarLayoutFields = {
  layout: sidebarLayoutConfigSchema.nullable(),
  mode: z.enum(['platform', 'user']),
} as const;

/** Full platform sidebar-layout document (direct-save; no revision token). */
export const adminSidebarLayoutGetOutputSchema = z.object(sidebarLayoutFields).strict();
export type AdminSidebarLayoutGetOutput = z.infer<typeof adminSidebarLayoutGetOutputSchema>;

/** Full-document update (direct-save; no expectedRevision). */
export const adminSidebarLayoutUpdateInputSchema = z.object(sidebarLayoutFields).strict();
export type AdminSidebarLayoutUpdateInput = z.infer<typeof adminSidebarLayoutUpdateInputSchema>;

export const adminSidebarLayoutUpdateOutputSchema = adminSidebarLayoutGetOutputSchema;
export type AdminSidebarLayoutUpdateOutput = z.infer<typeof adminSidebarLayoutUpdateOutputSchema>;
