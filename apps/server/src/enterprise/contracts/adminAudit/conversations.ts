import { z } from 'zod';

import {
  ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  adminAuditCursorSchema,
  dateInputSchema,
  limitSchema,
  platformAuditContentAccessModeSchema,
  titleQuerySchema,
  topicIdSchema,
  userIdSchema,
} from './common';

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

export type AdminAuditConversationsListInputParsed = z.output<
  typeof adminAuditConversationsListInputSchema
>;
export type AdminAuditConversationsMessagesInputParsed = z.output<
  typeof adminAuditConversationsMessagesInputSchema
>;
