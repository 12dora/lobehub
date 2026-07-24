import { z } from 'zod';

import {
  ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  adminAuditCursorSchema,
  adminAuditJobErrorSchema,
  auditReasonSchema,
  dateInputSchema,
  idSchema,
  limitSchema,
  platformAuditResultSchema,
  titleQuerySchema,
  topicIdSchema,
  userIdSchema,
} from './common';

// ── exports (A3) ─────────────────────────────────────────────────────────────

export const platformAuditExportKindSchema = z.enum([
  'operation_logs',
  'conversations',
  'user_timeline',
]);
export const platformAuditExportStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

/** Short-lived signed download URL TTL (seconds). */
export const ADMIN_AUDIT_EXPORT_DOWNLOAD_URL_TTL_SECONDS = 300;

/**
 * Create export: kind + reason + bounded window filters.
 * conversations / user_timeline require explicit userId.
 * includeMessageBodies is only honored when policy allows (service gate).
 */
export const adminAuditExportsCreateInputSchema = z
  .object({
    action: z.string().min(1).max(256).optional(),
    actions: z.array(z.string().min(1).max(256)).max(50).optional(),
    actorUserId: z.string().min(1).max(128).optional(),
    from: dateInputSchema,
    /**
     * When true, conversation exports include full message bodies (credential-masked).
     * Requires policy content_allowed + messageBodyInExport (enforced server-side).
     */
    includeMessageBodies: z.boolean().optional(),
    kind: platformAuditExportKindSchema,
    /** Title-only conversation search (never body). Only meaningful for conversations. */
    q: titleQuerySchema,
    reason: auditReasonSchema,
    requestId: z.string().min(1).max(128).optional(),
    result: platformAuditResultSchema.optional(),
    results: z.array(platformAuditResultSchema).max(10).optional(),
    targetId: z.string().min(1).max(128).optional(),
    targetType: z.string().min(1).max(64).optional(),
    to: dateInputSchema,
    topicId: topicIdSchema.optional(),
    /** Required for conversations / user_timeline (service also enforces). */
    userId: userIdSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.kind === 'conversations' || input.kind === 'user_timeline') && !input.userId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'userId is required for conversation and user_timeline exports',
        path: ['userId'],
      });
    }
    if (input.kind !== 'conversations' && input.q) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'q is only supported for conversations exports',
        path: ['q'],
      });
    }
    if (input.kind !== 'conversations' && input.includeMessageBodies) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'includeMessageBodies is only supported for conversations exports',
        path: ['includeMessageBodies'],
      });
    }
    if (
      input.kind !== 'operation_logs' &&
      (input.action ||
        input.actions ||
        input.actorUserId ||
        input.requestId ||
        input.result ||
        input.results ||
        input.targetId ||
        input.targetType)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'operation-log filters are only supported for operation_logs exports',
        path: ['kind'],
      });
    }
  })
  .transform((input) => ({
    ...input,
    includeMessageBodies: input.includeMessageBodies ?? false,
  }));

export type AdminAuditExportsCreateInput = z.input<typeof adminAuditExportsCreateInputSchema>;
export type AdminAuditExportsCreateInputParsed = z.output<
  typeof adminAuditExportsCreateInputSchema
>;

/** Public export row — never includes storageKey. */
export const adminAuditExportItemSchema = z
  .object({
    artifactBytes: z.number().int().nonnegative().nullable(),
    artifactChecksum: z.string().nullable(),
    createdAt: z.date(),
    /** Bounded stable code only — never raw exception messages or storage keys. */
    error: adminAuditJobErrorSchema.nullable(),
    expiresAt: z.date().nullable(),
    filterSnapshot: z
      .object({
        action: z.string().optional(),
        actions: z.array(z.string()).optional(),
        actorUserId: z.string().optional(),
        actorUserIds: z.array(z.string()).optional(),
        /** Frozen non-secret policy caps (public projection). */
        exportArtifactRetentionDays: z.number().int().positive().optional(),
        from: z.string().optional(),
        keyword: z.string().optional(),
        maxExportRows: z.number().int().positive().optional(),
        policyRevision: z.number().int().nonnegative().optional(),
        q: z.string().optional(),
        requestId: z.string().optional(),
        result: platformAuditResultSchema.optional(),
        results: z.array(platformAuditResultSchema).optional(),
        sessionId: z.string().optional(),
        targetId: z.string().optional(),
        targetType: z.string().optional(),
        to: z.string().optional(),
        topicId: z.string().optional(),
        userId: z.string().optional(),
        workspaceId: z.string().optional(),
      })
      .strict(),
    finishedAt: z.date().nullable(),
    id: z.string(),
    includesMessageBodies: z.boolean(),
    jobId: z.string().nullable(),
    kind: platformAuditExportKindSchema,
    requestedBy: z.string(),
    rowCount: z.number().int().nonnegative().nullable(),
    startedAt: z.date().nullable(),
    status: platformAuditExportStatusSchema,
    updatedAt: z.date(),
  })
  .strict();

export const adminAuditExportsCreateOutputSchema = adminAuditExportItemSchema;

export const adminAuditExportsListInputSchema = z
  .object({
    cursor: adminAuditCursorSchema.optional(),
    kind: platformAuditExportKindSchema.optional(),
    limit: limitSchema,
    /** When true, only exports requested by the caller. */
    mine: z.boolean().optional(),
    status: platformAuditExportStatusSchema.optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
    mine: input.mine ?? false,
  }));

export type AdminAuditExportsListInputParsed = z.output<typeof adminAuditExportsListInputSchema>;

export const adminAuditExportsListOutputSchema = z
  .object({
    items: z.array(adminAuditExportItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const adminAuditExportsGetInputSchema = z
  .object({
    id: idSchema,
  })
  .strict();

export const adminAuditExportsGetOutputSchema = adminAuditExportItemSchema;

export const adminAuditExportsDownloadInputSchema = z
  .object({
    id: idSchema,
    reason: auditReasonSchema,
  })
  .strict();

export const adminAuditExportsDownloadOutputSchema = z
  .object({
    artifactBytes: z.number().int().nonnegative().nullable(),
    artifactChecksum: z.string().nullable(),
    /** Short-lived signed HTTPS URL — never a permanent storage key. */
    downloadUrl: z.string().url(),
    expiresAt: z.date(),
    id: z.string(),
  })
  .strict();

export const adminAuditExportsCancelInputSchema = z
  .object({
    id: idSchema,
    reason: auditReasonSchema,
  })
  .strict();

export const adminAuditExportsCancelOutputSchema = adminAuditExportItemSchema;

export type AdminAuditExportsDownloadInput = z.infer<typeof adminAuditExportsDownloadInputSchema>;
export type AdminAuditExportsCancelInput = z.infer<typeof adminAuditExportsCancelInputSchema>;
