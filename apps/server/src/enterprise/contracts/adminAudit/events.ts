import { z } from 'zod';

import {
  ADMIN_AUDIT_FACET_DEFAULT_LIMIT,
  ADMIN_AUDIT_FACET_MAX_LIMIT,
  ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  adminAuditCursorSchema,
  dateInputSchema,
  idSchema,
  limitSchema,
  platformAuditResultSchema,
} from './common';

// ── events (operation logs) ──────────────────────────────────────────────────

export const adminAuditEventsListInputSchema = z
  .object({
    action: z.string().min(1).max(256).optional(),
    actions: z.array(z.string().min(1).max(256)).max(50).optional(),
    actorUserId: z.string().min(1).max(128).optional(),
    cursor: adminAuditCursorSchema.optional(),
    from: dateInputSchema.optional(),
    limit: limitSchema,
    requestId: z.string().min(1).max(128).optional(),
    result: platformAuditResultSchema.optional(),
    results: z.array(platformAuditResultSchema).max(10).optional(),
    targetId: z.string().min(1).max(128).optional(),
    targetType: z.string().min(1).max(64).optional(),
    to: dateInputSchema.optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  }));

export type AdminAuditEventsListInput = z.input<typeof adminAuditEventsListInputSchema>;
export type AdminAuditEventsListInputParsed = z.output<typeof adminAuditEventsListInputSchema>;

/** List omits large before/after diffs for performance. */
export const adminAuditEventListItemSchema = z
  .object({
    action: z.string(),
    actorUserId: z.string().nullable(),
    configRevision: z.number().nullable(),
    createdAt: z.date(),
    id: z.string(),
    ipHash: z.string().nullable(),
    reason: z.string().nullable(),
    requestId: z.string().nullable(),
    result: platformAuditResultSchema,
    targetId: z.string().nullable(),
    targetType: z.string(),
    userAgent: z.string().nullable(),
  })
  .strict();

export const adminAuditEventsListOutputSchema = z
  .object({
    items: z.array(adminAuditEventListItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const adminAuditEventsGetInputSchema = z
  .object({
    id: idSchema,
  })
  .strict();

/** Detail preserves full stored diffs (no additional read-time redaction). */
export const adminAuditEventDetailSchema = adminAuditEventListItemSchema
  .extend({
    afterDiff: z.record(z.unknown()).nullable(),
    beforeDiff: z.record(z.unknown()).nullable(),
  })
  .strict();

export const adminAuditEventsGetOutputSchema = adminAuditEventDetailSchema;

export const adminAuditEventsFacetsInputSchema = z
  .object({
    from: dateInputSchema.optional(),
    limit: z.number().int().min(1).max(ADMIN_AUDIT_FACET_MAX_LIMIT).optional(),
    to: dateInputSchema.optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_AUDIT_FACET_DEFAULT_LIMIT,
  }));

export const adminAuditEventsFacetsOutputSchema = z
  .object({
    actions: z.array(z.object({ count: z.number().int(), value: z.string() }).strict()),
    results: z.array(z.object({ count: z.number().int(), value: z.string() }).strict()),
  })
  .strict();

export const adminAuditEventsStatsInputSchema = z
  .object({
    from: dateInputSchema.optional(),
    to: dateInputSchema.optional(),
  })
  .strict();

export const adminAuditEventsStatsOutputSchema = z
  .object({
    denied: z.number().int().nonnegative(),
    failure: z.number().int().nonnegative(),
    success: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

export type AdminAuditEventsFacetsInputParsed = z.output<typeof adminAuditEventsFacetsInputSchema>;
