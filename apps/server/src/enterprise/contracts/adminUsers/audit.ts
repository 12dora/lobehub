import { z } from 'zod';

import {
  ADMIN_USERS_AUDIT_DEFAULT_LIMIT,
  ADMIN_USERS_LIST_MAX_LIMIT,
  adminUserCursorSchema,
  userIdSchema,
} from './common';

export const adminUsersGetAuditTrailInputSchema = z
  .object({
    cursor: adminUserCursorSchema.optional(),
    limit: z.number().int().min(1).max(ADMIN_USERS_LIST_MAX_LIMIT).optional(),
    userId: userIdSchema,
  })
  .strict()
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_USERS_AUDIT_DEFAULT_LIMIT,
  }));

export type AdminUsersGetAuditTrailInput = z.input<typeof adminUsersGetAuditTrailInputSchema>;
export type AdminUsersGetAuditTrailInputParsed = z.output<
  typeof adminUsersGetAuditTrailInputSchema
>;

/** Redacted audit row subset for the user detail page. */
export const adminUserAuditItemSchema = z
  .object({
    action: z.string(),
    actorUserId: z.string().nullable().optional(),
    createdAt: z.date(),
    id: z.string(),
    reason: z.string().nullable().optional(),
    result: z.enum(['success', 'failure', 'denied']),
    targetId: z.string().nullable().optional(),
    targetType: z.string(),
  })
  .strict();

export type AdminUserAuditItem = z.infer<typeof adminUserAuditItemSchema>;

export const adminUsersGetAuditTrailOutputSchema = z
  .object({
    items: z.array(adminUserAuditItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type AdminUsersGetAuditTrailOutput = z.infer<typeof adminUsersGetAuditTrailOutputSchema>;
