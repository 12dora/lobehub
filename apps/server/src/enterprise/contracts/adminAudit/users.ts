import { z } from 'zod';

import {
  ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  ADMIN_AUDIT_Q_MAX_LENGTH,
  adminAuditCursorSchema,
  dateInputSchema,
  limitSchema,
  platformAuditRedactionProfileSchema,
  userIdSchema,
} from './common';

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
    /** Live-view credential mask in force for this response (fail-closed if missing). */
    redactionProfile: platformAuditRedactionProfileSchema,
  })
  .strict();

export type AdminAuditUsersSearchInputParsed = z.output<typeof adminAuditUsersSearchInputSchema>;
export type AdminAuditUsersTimelineInputParsed = z.output<
  typeof adminAuditUsersTimelineInputSchema
>;
