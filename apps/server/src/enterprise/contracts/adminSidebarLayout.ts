import type { z } from 'zod';

import { platformSidebarLayoutSchema } from '@/types/platform/sidebarLayout';

/** Full platform sidebar-layout document (direct-save; no draft/publish CAS). */
export const adminSidebarLayoutGetOutputSchema = platformSidebarLayoutSchema;
export type AdminSidebarLayoutGetOutput = z.infer<typeof adminSidebarLayoutGetOutputSchema>;

export const adminSidebarLayoutUpdateInputSchema = platformSidebarLayoutSchema;
export type AdminSidebarLayoutUpdateInput = z.infer<typeof adminSidebarLayoutUpdateInputSchema>;

export const adminSidebarLayoutUpdateOutputSchema = platformSidebarLayoutSchema;
export type AdminSidebarLayoutUpdateOutput = z.infer<typeof adminSidebarLayoutUpdateOutputSchema>;
