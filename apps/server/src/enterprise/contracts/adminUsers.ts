/**
 * Centralized Zod contracts for `admin.users` (M04).
 * Procedures must import these schemas — do not redefine inputs/outputs inline.
 *
 * Dates are real `Date` values (superjson over tRPC). Secrets, tokens, and account
 * scope payloads are never part of these shapes. The create INPUT carries an initial
 * password (hashed server-side, never stored raw); passwords never appear in any
 * output, list, or audit shape.
 */
import { z } from 'zod';

import { PLATFORM_SYSTEM_ROLES, type PlatformSystemRoleName } from '@/const/platform/roles';

import { secretSafeAuditReasonSchema, strictDateSchema } from './shared';

/** Default page size for the users list (offset pagination). */
export const ADMIN_USERS_LIST_DEFAULT_LIMIT = 20;
/** Hard cap for list / audit trail limit. */
export const ADMIN_USERS_LIST_MAX_LIMIT = 100;
/** Hard cap for list offset (jump-to-page). */
export const ADMIN_USERS_LIST_MAX_OFFSET = 100_000;
/** Default page size for the user-detail audit trail (still keyset). */
export const ADMIN_USERS_AUDIT_DEFAULT_LIMIT = 50;

/**
 * Provisional recent-reauth window for high-risk mutations (M04).
 * M13 may tighten policy; keep this as the single server constant.
 */
export const ADMIN_REAUTH_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Fixed system role packages assignable via replaceGlobalRoles.
 * Derived from PLATFORM_SYSTEM_ROLES so admin assignment cannot drift from the catalog.
 */
export const ADMIN_USER_ASSIGNABLE_ROLE_NAMES = Object.values(PLATFORM_SYSTEM_ROLES) as [
  PlatformSystemRoleName,
  ...PlatformSystemRoleName[],
];

export type AdminUserAssignableRoleName = (typeof ADMIN_USER_ASSIGNABLE_ROLE_NAMES)[number];

export const adminUserAssignableRoleNameSchema = z.enum(ADMIN_USER_ASSIGNABLE_ROLE_NAMES);

export const adminUserStatusSchema = z.enum(['active', 'banned']);
export type AdminUserStatus = z.infer<typeof adminUserStatusSchema>;

/** Account source: local credential vs any non-credential (SSO) provider. */
export const adminUserSourceSchema = z.enum(['local', 'sso']);
export type AdminUserSource = z.infer<typeof adminUserSourceSchema>;

/** Opaque keyset cursor string: `${createdAt.toISOString()}|${id}`. */
export const adminUserCursorSchema = z.string().min(1).max(128);

const reasonSchema = secretSafeAuditReasonSchema;

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
    expiresAt: strictDateSchema.optional(),
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
    /**
     * Targeted revoke: revoke only these specific Better Auth session ids (must belong to
     * the target user). When present, the global security epoch is NOT advanced — only the
     * listed rows are deleted. Absent = revoke all sessions (existing behavior).
     */
    sessionIds: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
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

// ── create (credential user) ────────────────────────────────────────────────

/**
 * Admin-provisioned credential (email + password) user. The password bounds mirror
 * Better Auth's `minPasswordLength` / `maxPasswordLength` in
 * `src/libs/better-auth/define-config.ts` so the user can change it later.
 * The password is input-only — it must never be echoed in outputs or audits.
 */
export const adminUsersCreateInputSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(255),
    fullName: z.string().trim().min(1).max(100),
    password: z.string().min(8).max(64),
    reason: reasonSchema,
    username: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[\w.-]+$/)
      .optional(),
  })
  .strict();

export type AdminUsersCreateInput = z.infer<typeof adminUsersCreateInputSchema>;

/** Never returns the password or its hash. */
export const adminUsersCreateOutputSchema = z
  .object({
    created: z.literal(true),
    email: z.string(),
    userId: z.string(),
  })
  .strict();

export type AdminUsersCreateOutput = z.infer<typeof adminUsersCreateOutputSchema>;

// ── delete (hard delete) ──────────────────────────────────────────────────────

/**
 * Irreversible hard delete: removes the user row so every FK-cascade owned record
 * (sessions, accounts, messages, topics, agents, files, RBAC grants, …) is wiped.
 * Blocked for the actor's own account and the last permanent super admin.
 */
export const adminUsersDeleteInputSchema = z
  .object({
    reason: reasonSchema,
    userId: userIdSchema,
  })
  .strict();

export type AdminUsersDeleteInput = z.infer<typeof adminUsersDeleteInputSchema>;

export const adminUsersDeleteOutputSchema = z
  .object({
    deleted: z.literal(true),
    userId: z.string(),
  })
  .strict();

export type AdminUsersDeleteOutput = z.infer<typeof adminUsersDeleteOutputSchema>;

// ── replaceGlobalRoles ──────────────────────────────────────────────────────

export const adminUsersReplaceGlobalRolesInputSchema = z
  .object({
    expiresAt: strictDateSchema.optional(),
    /**
     * Role names whose existing grants must be left untouched (expiry preserved) instead
     * of deleted + re-inserted. Used by single-role revoke so removing one role never
     * silently strips a time-boxed expiry from the remaining grants. Must be a subset of
     * roleNames.
     */
    preserveRoleNames: z.array(adminUserAssignableRoleNameSchema).max(16).optional(),
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

    if (new Set(val.roleNames).size !== val.roleNames.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'roleNames must not contain duplicates',
        path: ['roleNames'],
      });
    }

    if (val.preserveRoleNames) {
      if (new Set(val.preserveRoleNames).size !== val.preserveRoleNames.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'preserveRoleNames must not contain duplicates',
          path: ['preserveRoleNames'],
        });
      }
      const desired = new Set(val.roleNames);
      for (const roleName of val.preserveRoleNames) {
        if (!desired.has(roleName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'preserveRoleNames must be a subset of roleNames',
            path: ['preserveRoleNames'],
          });
          break;
        }
      }
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
