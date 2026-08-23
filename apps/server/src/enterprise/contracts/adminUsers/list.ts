import { z } from 'zod';

import { strictDateSchema } from '../shared';
import {
  ADMIN_USERS_LIST_DEFAULT_LIMIT,
  ADMIN_USERS_LIST_MAX_LIMIT,
  ADMIN_USERS_LIST_MAX_OFFSET,
  adminUserCursorSchema,
  adminUserSourceSchema,
  adminUserStatusSchema,
  normalizeAdminUserQuery,
} from './common';

export const adminUsersListInputSchema = z
  .object({
    createdFrom: strictDateSchema.optional(),
    createdTo: strictDateSchema.optional(),
    /** Kept for backward compatibility; new callers should use `offset`. */
    cursor: adminUserCursorSchema.optional(),
    limit: z.number().int().min(1).max(ADMIN_USERS_LIST_MAX_LIMIT).optional(),
    offset: z.number().int().min(0).max(ADMIN_USERS_LIST_MAX_OFFSET).optional(),
    /** Free-text search; server trims/normalizes. Never log the full value. */
    query: z.string().max(200).optional(),
    role: z.string().min(1).max(64).optional(),
    source: adminUserSourceSchema.optional(),
    status: adminUserStatusSchema.optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_USERS_LIST_DEFAULT_LIMIT,
    offset: input.offset ?? 0,
    query: normalizeAdminUserQuery(input.query),
  }));

export type AdminUsersListInput = z.input<typeof adminUsersListInputSchema>;
export type AdminUsersListInputParsed = z.output<typeof adminUsersListInputSchema>;

export const adminUserListItemSchema = z
  .object({
    avatar: z.string().nullable(),
    createdAt: z.date(),
    dingtalkTitle: z.string().nullable(),
    email: z.string().nullable(),
    fullName: z.string().nullable(),
    id: z.string(),
    lastActiveAt: z.date().nullable(),
    /**
     * Distinct Better Auth / OAuth provider ids for the user (e.g. credential, google).
     * Never includes account id, token, password, or scope.
     */
    providerIds: z.array(z.string()),
    /** Global platform role names only (not workspace roles). */
    roles: z.array(z.string()),
    status: adminUserStatusSchema,
    username: z.string().nullable(),
  })
  .strict();

export type AdminUserListItem = z.infer<typeof adminUserListItemSchema>;

export const adminUsersListOutputSchema = z
  .object({
    items: z.array(adminUserListItemSchema),
    /** Keyset cursor for older callers; new UI uses `offset` + `total`. */
    nextCursor: z.string().nullable(),
    /** Count of rows matching the same WHERE (filters only — not offset/cursor). */
    total: z.number().int().nonnegative(),
  })
  .strict();

export type AdminUsersListOutput = z.infer<typeof adminUsersListOutputSchema>;
