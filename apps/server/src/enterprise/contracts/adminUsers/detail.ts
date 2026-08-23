import { z } from 'zod';

import { adminUserStatusSchema, userIdSchema } from './common';

export const adminUsersGetInputSchema = z
  .object({
    userId: userIdSchema,
  })
  .strict();

export type AdminUsersGetInput = z.infer<typeof adminUsersGetInputSchema>;

/** Provider summary only — never password, tokens, or scope. */
export const adminUserProviderSummarySchema = z
  .object({
    accountIdHint: z.string().nullable().optional(),
    createdAt: z.date().nullable().optional(),
    providerId: z.string(),
  })
  .strict();

export type AdminUserProviderSummary = z.infer<typeof adminUserProviderSummarySchema>;

export const adminUserGlobalRoleSchema = z
  .object({
    displayName: z.string().nullable().optional(),
    expiresAt: z.date().nullable().optional(),
    id: z.string(),
    name: z.string(),
  })
  .strict();

/** Safe session metadata for admin detail — never session token. */
export const adminUserSessionSummarySchema = z
  .object({
    createdAt: z.date(),
    expiresAt: z.date(),
    id: z.string(),
    ipAddress: z.string().nullable().optional(),
    updatedAt: z.date().nullable().optional(),
    userAgent: z.string().nullable().optional(),
  })
  .strict();

export type AdminUserSessionSummary = z.infer<typeof adminUserSessionSummarySchema>;

export const adminUsersGetOutputSchema = z
  .object({
    avatar: z.string().nullable(),
    banExpires: z.date().nullable(),
    banReason: z.string().nullable(),
    banned: z.boolean(),
    createdAt: z.date(),
    dingtalkTitle: z.string().nullable(),
    email: z.string().nullable(),
    emailVerified: z.boolean().optional(),
    fullName: z.string().nullable(),
    id: z.string(),
    /**
     * Server-computed: target user id equals the authenticated actor.
     * Clients must not invent self state — always trust this field.
     */
    isSelf: z.boolean(),
    lastActiveAt: z.date().nullable(),
    /**
     * Whether a Better Auth credential account with a non-empty password exists.
     * Same predicate as `/api/auth/check-user`. Never includes the hash.
     */
    hasPassword: z.boolean(),
    /** Count of Better Auth passkey rows. Aggregate only — no credential material. */
    passkeyCount: z.number().int().nonnegative(),
    providers: z.array(adminUserProviderSummarySchema),
    roles: z.array(adminUserGlobalRoleSchema),
    sessionCount: z.number().int().nonnegative(),
    /** Bounded recent sessions for the detail page (tokens never included). */
    sessions: z.array(adminUserSessionSummarySchema),
    status: adminUserStatusSchema,
    twoFactorEnabled: z.boolean(),
    username: z.string().nullable(),
  })
  .strict();

export type AdminUsersGetOutput = z.infer<typeof adminUsersGetOutputSchema>;
