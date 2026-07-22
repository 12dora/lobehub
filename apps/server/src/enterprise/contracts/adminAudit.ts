/**
 * Strict Zod contracts for `admin.audit.*` (A2).
 *
 * Data contract:
 * - Operation event detail returns stored before/after diffs (write-time redaction only).
 * - Conversation/message body is full and unlimited when content_allowed + permission;
 *   only credentials are masked — no PII/business-text redaction or length truncation.
 * - Lists may omit large detail fields; detail preserves full non-credential evidence.
 * - Access-log filter summaries never include free-text `q` or message bodies.
 */

import { z } from 'zod';

import { containsEnterpriseSecretMaterial } from '../security/redaction';

export const ADMIN_AUDIT_LIST_DEFAULT_LIMIT = 50;
export const ADMIN_AUDIT_LIST_MAX_LIMIT = 200;
export const ADMIN_AUDIT_FACET_DEFAULT_LIMIT = 20;
export const ADMIN_AUDIT_FACET_MAX_LIMIT = 50;
export const ADMIN_AUDIT_Q_MAX_LENGTH = 200;
export const ADMIN_AUDIT_REASON_MAX_LENGTH = 2000;

/** Opaque keyset cursor: `${createdAt.toISOString()}|${id}`. */
export const adminAuditCursorSchema = z.string().min(1).max(128);

const auditReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(ADMIN_AUDIT_REASON_MAX_LENGTH)
  .refine(
    (value) => !containsEnterpriseSecretMaterial(value),
    'credential material is not allowed in audit reasons',
  );

/** Bounded date — real Date via superjson; reject invalid. */
const dateInputSchema = z.coerce.date();

const limitSchema = z.number().int().min(1).max(ADMIN_AUDIT_LIST_MAX_LIMIT).optional();

/** Title-only search string (conversations). Never full-text body search. */
const titleQuerySchema = z.string().trim().min(1).max(ADMIN_AUDIT_Q_MAX_LENGTH).optional();

const userIdSchema = z.string().min(1).max(128);
const topicIdSchema = z.string().min(1).max(128);
const idSchema = z.string().min(1).max(128);

export const platformAuditResultSchema = z.enum(['success', 'failure', 'denied']);
export const platformAuditContentAccessModeSchema = z.enum([
  'disabled',
  'metadata_only',
  'content_allowed',
]);
export const platformAuditRedactionProfileSchema = z.enum(['strict', 'standard']);
export const platformAuditLegalHoldScopeTypeSchema = z.enum([
  'user',
  'session',
  'topic',
  'workspace',
  'global',
]);
export const platformAuditLegalHoldStatusSchema = z.enum(['active', 'released']);

// ── shared window ────────────────────────────────────────────────────────────

/**
 * Optional inclusive `from` + exclusive `to`.
 * Service enforces maxListWindowDays and defaults the window when omitted.
 */
export const adminAuditTimeWindowSchema = z
  .object({
    from: dateInputSchema.optional(),
    to: dateInputSchema.optional(),
  })
  .strict();

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

// ── conversations ────────────────────────────────────────────────────────────

export const adminAuditConversationsListInputSchema = z
  .object({
    cursor: adminAuditCursorSchema.optional(),
    from: dateInputSchema.optional(),
    limit: limitSchema,
    /** Title-only query — never body search. */
    q: titleQuerySchema,
    to: dateInputSchema.optional(),
    userId: userIdSchema,
  })
  .strict()
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  }));

export const adminAuditConversationListItemSchema = z
  .object({
    agentId: z.string().nullable(),
    createdAt: z.date(),
    description: z.string().nullable(),
    id: z.string(),
    model: z.string().nullable(),
    provider: z.string().nullable(),
    sessionId: z.string().nullable(),
    status: z.string().nullable(),
    title: z.string().nullable(),
    updatedAt: z.date(),
    userId: z.string(),
  })
  .strict();

export const adminAuditConversationsListOutputSchema = z
  .object({
    items: z.array(adminAuditConversationListItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const adminAuditConversationsGetInputSchema = z
  .object({
    topicId: topicIdSchema,
    userId: userIdSchema,
  })
  .strict();

export const adminAuditConversationsGetOutputSchema = adminAuditConversationListItemSchema
  .extend({
    /** Omitted when policy is metadata_only / disabled for content. */
    content: z.string().nullable().optional(),
    contentAccessMode: platformAuditContentAccessModeSchema,
    editorData: z.unknown().optional(),
    historySummary: z.string().nullable().optional(),
  })
  .strict();

export const adminAuditConversationsMessagesInputSchema = z
  .object({
    cursor: adminAuditCursorSchema.optional(),
    from: dateInputSchema.optional(),
    /**
     * When true and policy allows, return full message bodies (credential-masked only).
     * Default false → list projection without body for performance.
     */
    includeBody: z.boolean().optional(),
    limit: limitSchema,
    to: dateInputSchema.optional(),
    topicId: topicIdSchema,
    userId: userIdSchema,
  })
  .strict()
  .transform((input) => ({
    ...input,
    includeBody: input.includeBody ?? false,
    limit: input.limit ?? ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  }));

export const adminAuditConversationMessageListItemSchema = z
  .object({
    agentId: z.string().nullable(),
    content: z.string().nullable().optional(),
    contentAccessMode: platformAuditContentAccessModeSchema.optional(),
    createdAt: z.date(),
    editorData: z.unknown().optional(),
    error: z.unknown().optional(),
    hasContent: z.boolean().optional(),
    id: z.string(),
    model: z.string().nullable(),
    parentId: z.string().nullable(),
    provider: z.string().nullable(),
    role: z.string(),
    sessionId: z.string().nullable(),
    topicId: z.string().nullable(),
    updatedAt: z.date(),
    userId: z.string(),
  })
  .strict();

export const adminAuditConversationsMessagesOutputSchema = z
  .object({
    contentAccessMode: platformAuditContentAccessModeSchema,
    items: z.array(adminAuditConversationMessageListItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

// ── users ────────────────────────────────────────────────────────────────────

export const adminAuditUsersSearchInputSchema = z
  .object({
    cursor: adminAuditCursorSchema.optional(),
    limit: limitSchema,
    q: z.string().trim().min(1).max(ADMIN_AUDIT_Q_MAX_LENGTH),
  })
  .strict()
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
    q: input.q.trim().toLowerCase(),
  }));

export const adminAuditUserSearchItemSchema = z
  .object({
    createdAt: z.date(),
    email: z.string().nullable(),
    fullName: z.string().nullable(),
    id: z.string(),
    lastActiveAt: z.date().nullable(),
    username: z.string().nullable(),
  })
  .strict();

export const adminAuditUsersSearchOutputSchema = z
  .object({
    items: z.array(adminAuditUserSearchItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const adminAuditUsersSummaryInputSchema = z
  .object({
    userId: userIdSchema,
  })
  .strict();

export const adminAuditUsersSummaryOutputSchema = z
  .object({
    createdAt: z.date(),
    email: z.string().nullable(),
    fullName: z.string().nullable(),
    id: z.string(),
    lastActiveAt: z.date().nullable(),
    messageCount: z.number().int().nonnegative(),
    topicCount: z.number().int().nonnegative(),
    username: z.string().nullable(),
  })
  .strict();

export const adminAuditUsersTimelineInputSchema = z
  .object({
    cursor: adminAuditCursorSchema.optional(),
    from: dateInputSchema.optional(),
    limit: limitSchema,
    to: dateInputSchema.optional(),
    userId: userIdSchema,
  })
  .strict()
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  }));

export const adminAuditUsersTimelineItemSchema = z
  .object({
    createdAt: z.date(),
    id: z.string(),
    kind: z.enum(['topic', 'session']),
    sessionId: z.string().nullable(),
    title: z.string().nullable(),
    topicId: z.string().nullable(),
    updatedAt: z.date(),
  })
  .strict();

export const adminAuditUsersTimelineOutputSchema = z
  .object({
    items: z.array(adminAuditUsersTimelineItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

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

// ── stable filter summary for access logs (never free text / body) ───────────

export const adminAuditAccessFilterSummarySchema = z
  .object({
    actionPresent: z.boolean().optional(),
    actionsCount: z.number().int().nonnegative().optional(),
    actorUserIdPresent: z.boolean().optional(),
    cursorPresent: z.boolean().optional(),
    fromPresent: z.boolean().optional(),
    hasQ: z.boolean().optional(),
    includeBody: z.boolean().optional(),
    limit: z.number().int().optional(),
    requestIdPresent: z.boolean().optional(),
    resultPresent: z.boolean().optional(),
    scopeType: z.string().optional(),
    targetIdPresent: z.boolean().optional(),
    targetTypePresent: z.boolean().optional(),
    toPresent: z.boolean().optional(),
    topicIdPresent: z.boolean().optional(),
    userIdPresent: z.boolean().optional(),
  })
  .strict();

export type AdminAuditAccessFilterSummary = z.infer<typeof adminAuditAccessFilterSummarySchema>;

export type AdminAuditEventsFacetsInputParsed = z.output<typeof adminAuditEventsFacetsInputSchema>;
export type AdminAuditPolicyUpdateInput = z.infer<typeof adminAuditPolicyUpdateInputSchema>;
export type AdminAuditConversationsListInputParsed = z.output<
  typeof adminAuditConversationsListInputSchema
>;
export type AdminAuditConversationsMessagesInputParsed = z.output<
  typeof adminAuditConversationsMessagesInputSchema
>;
export type AdminAuditUsersSearchInputParsed = z.output<typeof adminAuditUsersSearchInputSchema>;
export type AdminAuditUsersTimelineInputParsed = z.output<
  typeof adminAuditUsersTimelineInputSchema
>;
export type AdminAuditLegalHoldsListInputParsed = z.output<
  typeof adminAuditLegalHoldsListInputSchema
>;
export type AdminAuditLegalHoldsCreateInput = z.infer<typeof adminAuditLegalHoldsCreateInputSchema>;
export type AdminAuditLegalHoldsReleaseInput = z.infer<
  typeof adminAuditLegalHoldsReleaseInputSchema
>;
