/**
 * Centralized Zod contracts for `admin.users` (M04).
 * Procedures must import these schemas — do not redefine inputs/outputs inline.
 *
 * Dates are real `Date` values (superjson over tRPC). Secrets, tokens, passwords,
 * and account scope payloads are never part of these shapes.
 */
import { z } from 'zod';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

/** Default page size for list / audit trail. */
export const ADMIN_USERS_LIST_DEFAULT_LIMIT = 50;
/** Hard cap for list / audit trail limit. */
export const ADMIN_USERS_LIST_MAX_LIMIT = 100;

/**
 * Provisional recent-reauth window for high-risk mutations (M04).
 * M13 may tighten policy; keep this as the single server constant.
 */
export const ADMIN_REAUTH_MAX_AGE_MS = 15 * 60 * 1000;

/** Fixed system role packages assignable via replaceGlobalRoles. */
export const ADMIN_USER_ASSIGNABLE_ROLE_NAMES = [
  PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
  PLATFORM_SYSTEM_ROLES.USER_ADMIN,
  PLATFORM_SYSTEM_ROLES.AI_ADMIN,
  PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
  PLATFORM_SYSTEM_ROLES.AUDITOR,
  PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
] as const;

export type AdminUserAssignableRoleName = (typeof ADMIN_USER_ASSIGNABLE_ROLE_NAMES)[number];

export const adminUserAssignableRoleNameSchema = z.enum(
  ADMIN_USER_ASSIGNABLE_ROLE_NAMES as unknown as [
    AdminUserAssignableRoleName,
    ...AdminUserAssignableRoleName[],
  ],
);

export const adminUserStatusSchema = z.enum(['active', 'banned']);
export type AdminUserStatus = z.infer<typeof adminUserStatusSchema>;

/** Opaque keyset cursor string: `${createdAt.toISOString()}|${id}`. */
export const adminUserCursorSchema = z.string().min(1).max(128);

const reasonSchema = z.string().trim().min(1).max(2000);

const userIdSchema = z.string().min(1).max(128);

/**
 * Normalize free-text search: trim, collapse internal whitespace, lowercase.
 * Does **not** escape LIKE wildcards — callers must escape before SQL.
 * Empty after trim → undefined (no filter).
 */
export const normalizeAdminUserQuery = (raw: string | undefined | null): string | undefined => {
  if (raw == null) return undefined;
  const normalized = raw.trim().replaceAll(/\s+/g, ' ').toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
};

/**
 * Escape `%`, `_`, and `\` for prefix-safe SQL LIKE / ILIKE patterns.
 * Output is safe to concatenate as `${escaped}%` (prefix only).
 */
export const escapeLikePattern = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

// ── list ────────────────────────────────────────────────────────────────────

export const adminUsersListInputSchema = z
  .object({
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
    cursor: adminUserCursorSchema.optional(),
    limit: z.number().int().min(1).max(ADMIN_USERS_LIST_MAX_LIMIT).optional(),
    /** Free-text search; server trims/normalizes. Never log the full value. */
    query: z.string().max(200).optional(),
    role: z.string().min(1).max(64).optional(),
    status: adminUserStatusSchema.optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_USERS_LIST_DEFAULT_LIMIT,
    query: normalizeAdminUserQuery(input.query),
  }));

export type AdminUsersListInput = z.input<typeof adminUsersListInputSchema>;
export type AdminUsersListInputParsed = z.output<typeof adminUsersListInputSchema>;

export const adminUserListItemSchema = z
  .object({
    avatar: z.string().nullable(),
    createdAt: z.date(),
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
    nextCursor: z.string().nullable(),
  })
  .strict();

export type AdminUsersListOutput = z.infer<typeof adminUsersListOutputSchema>;

// ── get ─────────────────────────────────────────────────────────────────────

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

export type AdminUserGlobalRole = z.infer<typeof adminUserGlobalRoleSchema>;

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
    providers: z.array(adminUserProviderSummarySchema),
    roles: z.array(adminUserGlobalRoleSchema),
    sessionCount: z.number().int().nonnegative(),
    /** Bounded recent sessions for the detail page (tokens never included). */
    sessions: z.array(adminUserSessionSummarySchema),
    status: adminUserStatusSchema,
    username: z.string().nullable(),
  })
  .strict();

export type AdminUsersGetOutput = z.infer<typeof adminUsersGetOutputSchema>;

// ── ban / unban ─────────────────────────────────────────────────────────────

export const adminUsersBanInputSchema = z
  .object({
    expiresAt: z.coerce.date().optional(),
    reason: reasonSchema,
    userId: userIdSchema,
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.expiresAt && val.expiresAt.getTime() <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expiresAt must be in the future',
        path: ['expiresAt'],
      });
    }
  });

export type AdminUsersBanInput = z.infer<typeof adminUsersBanInputSchema>;

export const adminUsersBanOutputSchema = z
  .object({
    banExpires: z.date().nullable(),
    banned: z.literal(true),
    userId: z.string(),
  })
  .strict();

export type AdminUsersBanOutput = z.infer<typeof adminUsersBanOutputSchema>;

export const adminUsersUnbanInputSchema = z
  .object({
    reason: reasonSchema,
    userId: userIdSchema,
  })
  .strict();

export type AdminUsersUnbanInput = z.infer<typeof adminUsersUnbanInputSchema>;

export const adminUsersUnbanOutputSchema = z
  .object({
    banned: z.literal(false),
    userId: z.string(),
  })
  .strict();

export type AdminUsersUnbanOutput = z.infer<typeof adminUsersUnbanOutputSchema>;

// ── revokeSessions ──────────────────────────────────────────────────────────

export const adminUsersRevokeSessionsInputSchema = z
  .object({
    /** When true, also revoke the actor's current session if actor === target. Default false. */
    includeCurrent: z.boolean().optional(),
    reason: reasonSchema,
    userId: userIdSchema,
  })
  .strict();

export type AdminUsersRevokeSessionsInput = z.infer<typeof adminUsersRevokeSessionsInputSchema>;

export const adminUsersRevokeSessionsOutputSchema = z
  .object({
    revokedCount: z.number().int().nonnegative(),
    userId: z.string(),
  })
  .strict();

export type AdminUsersRevokeSessionsOutput = z.infer<typeof adminUsersRevokeSessionsOutputSchema>;

// ── replaceGlobalRoles ──────────────────────────────────────────────────────

export const adminUsersReplaceGlobalRolesInputSchema = z
  .object({
    expiresAt: z.coerce.date().optional(),
    reason: reasonSchema,
    roleNames: z.array(adminUserAssignableRoleNameSchema).max(16),
    userId: userIdSchema,
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.expiresAt && val.expiresAt.getTime() <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expiresAt must be in the future',
        path: ['expiresAt'],
      });
    }
  });

export type AdminUsersReplaceGlobalRolesInput = z.infer<
  typeof adminUsersReplaceGlobalRolesInputSchema
>;

export const adminUsersReplaceGlobalRolesOutputSchema = z
  .object({
    expiresAt: z.date().nullable().optional(),
    roleNames: z.array(z.string()),
    userId: z.string(),
  })
  .strict();

export type AdminUsersReplaceGlobalRolesOutput = z.infer<
  typeof adminUsersReplaceGlobalRolesOutputSchema
>;

// ── getAuditTrail ───────────────────────────────────────────────────────────

export const adminUsersGetAuditTrailInputSchema = z
  .object({
    cursor: adminUserCursorSchema.optional(),
    limit: z.number().int().min(1).max(ADMIN_USERS_LIST_MAX_LIMIT).optional(),
    userId: userIdSchema,
  })
  .strict()
  .transform((input) => ({
    ...input,
    limit: input.limit ?? ADMIN_USERS_LIST_DEFAULT_LIMIT,
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
