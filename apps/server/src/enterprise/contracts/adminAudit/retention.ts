import { z } from 'zod';

import {
  ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  adminAuditCursorSchema,
  adminAuditJobErrorSchema,
  auditReasonSchema,
  idSchema,
  limitSchema,
} from './common';

// ── retention (A3) ───────────────────────────────────────────────────────────

/** API scope including fan-out `all` (never persisted as a single row). */
export const platformAuditRetentionApiScopeSchema = z.enum([
  'operation_logs',
  'conversations',
  'export_artifacts',
  'all',
]);

/** Stored single-scope only. */
export const platformAuditRetentionScopeSchema = z.enum([
  'operation_logs',
  'conversations',
  'export_artifacts',
]);

export const platformAuditRetentionModeSchema = z.enum(['dry_run', 'execute']);

export const platformAuditRetentionRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const adminAuditRetentionCountsSchema = z
  .object({
    conversationsDeleted: z.number().int().nonnegative().optional(),
    conversationsScanned: z.number().int().nonnegative().optional(),
    exportArtifactsDeleted: z.number().int().nonnegative().optional(),
    exportArtifactsScanned: z.number().int().nonnegative().optional(),
    messagesDeleted: z.number().int().nonnegative().optional(),
    messagesScanned: z.number().int().nonnegative().optional(),
    operationLogsDeleted: z.number().int().nonnegative().optional(),
    operationLogsScanned: z.number().int().nonnegative().optional(),
    sessionsDeleted: z.number().int().nonnegative().optional(),
    sessionsScanned: z.number().int().nonnegative().optional(),
    skippedLegalHold: z.number().int().nonnegative().optional(),
    topicsDeleted: z.number().int().nonnegative().optional(),
    topicsScanned: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Public retention run projection. */
export const adminAuditRetentionRunItemSchema = z
  .object({
    counts: adminAuditRetentionCountsSchema,
    createdAt: z.date(),
    cutoffAt: z.date(),
    /** Bounded stable code only — never raw exception messages or storage keys. */
    error: adminAuditJobErrorSchema.nullable(),
    finishedAt: z.date().nullable(),
    id: z.string(),
    jobId: z.string().nullable(),
    mode: platformAuditRetentionModeSchema,
    policyRevision: z.number().int().nonnegative(),
    progressDone: z.number().int().nonnegative(),
    progressTotal: z.number().int().nonnegative().nullable(),
    requestedBy: z.string(),
    scope: platformAuditRetentionScopeSchema,
    startedAt: z.date().nullable(),
    status: platformAuditRetentionRunStatusSchema,
    updatedAt: z.date(),
  })
  .strict();

export const adminAuditRetentionCreateInputSchema = z
  .object({
    reason: auditReasonSchema,
    scope: platformAuditRetentionApiScopeSchema,
  })
  .strict();

export type AdminAuditRetentionCreateInput = z.infer<typeof adminAuditRetentionCreateInputSchema>;

/** dryRun / run always return `items` (length 1 for single scope, 3 for `all`). */
export const adminAuditRetentionCreateOutputSchema = z
  .object({
    items: z.array(adminAuditRetentionRunItemSchema).min(1).max(3),
  })
  .strict();

export const adminAuditRetentionListRunsInputSchema = z
  .object({
    cursor: adminAuditCursorSchema.optional(),
    limit: limitSchema,
    mode: platformAuditRetentionModeSchema.optional(),
    /** When true, only runs requested by the caller. */
    mine: z.boolean().optional(),
    scope: platformAuditRetentionScopeSchema.optional(),
    status: platformAuditRetentionRunStatusSchema.optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
    mine: input.mine ?? false,
  }));

export type AdminAuditRetentionListRunsInputParsed = z.output<
  typeof adminAuditRetentionListRunsInputSchema
>;

export const adminAuditRetentionListRunsOutputSchema = z
  .object({
    items: z.array(adminAuditRetentionRunItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const adminAuditRetentionGetRunInputSchema = z
  .object({
    id: idSchema,
  })
  .strict();

export const adminAuditRetentionGetRunOutputSchema = adminAuditRetentionRunItemSchema;

/** status is an alias of getRun (same I/O). */
export const adminAuditRetentionStatusInputSchema = adminAuditRetentionGetRunInputSchema;
export const adminAuditRetentionStatusOutputSchema = adminAuditRetentionGetRunOutputSchema;

export const adminAuditRetentionCancelInputSchema = z
  .object({
    id: idSchema,
    reason: auditReasonSchema,
  })
  .strict();

export type AdminAuditRetentionCancelInput = z.infer<typeof adminAuditRetentionCancelInputSchema>;

export const adminAuditRetentionCancelOutputSchema = adminAuditRetentionRunItemSchema;
