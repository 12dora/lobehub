import type { z } from 'zod';

import { platformAuthSettingsSchema } from '@/types/platform/authSettings';

/** Full platform auth-settings document (direct-save; no draft/publish CAS). */
export const adminAuthSettingsGetOutputSchema = platformAuthSettingsSchema;
export type AdminAuthSettingsGetOutput = z.infer<typeof adminAuthSettingsGetOutputSchema>;

export const adminAuthSettingsUpdateInputSchema = platformAuthSettingsSchema;
export type AdminAuthSettingsUpdateInput = z.infer<typeof adminAuthSettingsUpdateInputSchema>;

export const adminAuthSettingsUpdateOutputSchema = platformAuthSettingsSchema;
export type AdminAuthSettingsUpdateOutput = z.infer<typeof adminAuthSettingsUpdateOutputSchema>;
