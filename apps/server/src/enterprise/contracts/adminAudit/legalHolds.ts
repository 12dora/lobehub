import { z } from 'zod';

import {
  ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  adminAuditCursorSchema,
  auditReasonSchema,
  dateInputSchema,
  idSchema,
  limitSchema,
  platformAuditLegalHoldScopeTypeSchema,
  platformAuditLegalHoldStatusSchema,
} from './common';

// ── legal holds ──────────────────────────────────────────────────────────────

export const adminAuditLegalHoldsListInputSchema = z
  .object({
    createdBy: z.string().min(1).max(128).optional(),
    cursor: adminAuditCursorSchema.optional(),
    limit: limitSchema,
    scopeId: z.string().min(1).max(128).nullable().optional(),
    scopeType: platformAuditLegalHoldScopeTypeSchema.optional(),
    status: platformAuditLegalHoldStatusSchema.optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  }));

export const adminAuditLegalHoldItemSchema = z
  .object({
    createdAt: z.date(),
    createdBy: z.string(),
    expiresAt: z.date().nullable(),
    id: z.string(),
    reason: z.string(),
    releaseReason: z.string().nullable(),
    releasedAt: z.date().nullable(),
    releasedBy: z.string().nullable(),
    scopeId: z.string().nullable(),
    scopeType: platformAuditLegalHoldScopeTypeSchema,
    status: platformAuditLegalHoldStatusSchema,
    updatedAt: z.date(),
  })
  .strict();

export const adminAuditLegalHoldsListOutputSchema = z
  .object({
    items: z.array(adminAuditLegalHoldItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const adminAuditLegalHoldsGetInputSchema = z
  .object({
    id: idSchema,
  })
  .strict();

export const adminAuditLegalHoldsGetOutputSchema = adminAuditLegalHoldItemSchema;

export const adminAuditLegalHoldsCreateInputSchema = z
  .object({
    expiresAt: dateInputSchema.nullable().optional(),
    reason: auditReasonSchema,
    scopeId: z.string().min(1).max(128).nullable().optional(),
    scopeType: platformAuditLegalHoldScopeTypeSchema,
  })
  .strict();

export const adminAuditLegalHoldsCreateOutputSchema = adminAuditLegalHoldItemSchema;

export const adminAuditLegalHoldsReleaseInputSchema = z
  .object({
    id: idSchema,
    releaseReason: auditReasonSchema,
  })
  .strict();

export const adminAuditLegalHoldsReleaseOutputSchema = adminAuditLegalHoldItemSchema;

export type AdminAuditLegalHoldsListInputParsed = z.output<
  typeof adminAuditLegalHoldsListInputSchema
>;
export type AdminAuditLegalHoldsCreateInput = z.infer<typeof adminAuditLegalHoldsCreateInputSchema>;
export type AdminAuditLegalHoldsReleaseInput = z.infer<
  typeof adminAuditLegalHoldsReleaseInputSchema
>;
