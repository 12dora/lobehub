import { z } from 'zod';

import {
  auditReasonSchema,
  platformAuditContentAccessModeSchema,
  platformAuditRedactionProfileSchema,
} from './common';

// ── policy ───────────────────────────────────────────────────────────────────

export const adminAuditPolicyGetOutputSchema = z
  .object({
    contentAccessMode: platformAuditContentAccessModeSchema,
    conversationRetentionDays: z.number().int().positive(),
    createdAt: z.date(),
    exportArtifactRetentionDays: z.number().int().positive(),
    id: z.string(),
    maxExportRows: z.number().int().positive(),
    maxListWindowDays: z.number().int().positive(),
    messageBodyInExport: z.boolean(),
    operationLogRetentionDays: z.number().int().positive(),
    redactionProfile: platformAuditRedactionProfileSchema,
    revision: z.number().int().nonnegative(),
    updatedAt: z.date(),
    updatedBy: z.string().nullable(),
  })
  .strict();

export const adminAuditPolicyUpdateInputSchema = z
  .object({
    contentAccessMode: platformAuditContentAccessModeSchema.optional(),
    conversationRetentionDays: z.number().int().min(1).max(3650).optional(),
    expectedRevision: z.number().int().nonnegative(),
    exportArtifactRetentionDays: z.number().int().min(1).max(365).optional(),
    maxExportRows: z.number().int().min(1).max(1_000_000).optional(),
    maxListWindowDays: z.number().int().min(1).max(365).optional(),
    messageBodyInExport: z.boolean().optional(),
    operationLogRetentionDays: z.number().int().min(1).max(3650).optional(),
    reason: auditReasonSchema,
    redactionProfile: platformAuditRedactionProfileSchema.optional(),
  })
  .strict();

export const adminAuditPolicyUpdateOutputSchema = adminAuditPolicyGetOutputSchema;

export type AdminAuditPolicyUpdateInput = z.infer<typeof adminAuditPolicyUpdateInputSchema>;
