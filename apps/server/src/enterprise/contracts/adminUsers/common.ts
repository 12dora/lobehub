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

import { secretSafeAuditReasonSchema } from '../shared';

/**
 * Default page size for the users list (offset pagination).
 * Mirrors the admin UI's shared DEFAULT_PAGE_SIZE so an omitted limit matches the table.
 */
export const ADMIN_USERS_LIST_DEFAULT_LIMIT = 20;
/** Hard cap for list / audit trail limit. */
export const ADMIN_USERS_LIST_MAX_LIMIT = 100;
/** Hard cap for list offset (jump-to-page). */
export const ADMIN_USERS_LIST_MAX_OFFSET = 100_000;
/**
 * Default page size for the user-detail audit trail (still keyset).
 * Same shared default as the rest of the admin lists.
 */
export const ADMIN_USERS_AUDIT_DEFAULT_LIMIT = 20;

/**
 * Recent-reauth window for high-risk mutations (M04). Single server constant.
 *
 * This was 15 minutes, which did not survive contact with real administration.
 * `authenticatedAt` is the session's ORIGINAL login time and is never refreshed
 * (see `packages/trpc/src/lambda/context.ts`) — so a quarter of an hour after
 * signing in, ~80 admin mutations began failing with `ADMIN_REAUTH_REQUIRED`,
 * and the only cure was the sign-in popup in `requestAdminReauth`, which is
 * exactly what a pop-up blocker eats. Saving a provider draft or toggling a
 * module should not require logging in again.
 *
 * A working day is the honest window. The control still bounds what a stolen
 * long-lived session (better-auth sessions outlive this by weeks) can reach,
 * which is the threat it was actually built for — an abandoned or replayed
 * session, not an admin who has been working for twenty minutes.
 */
export const ADMIN_REAUTH_MAX_AGE_MS = 8 * 60 * 60 * 1000;

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

export const reasonSchema = secretSafeAuditReasonSchema;

export const userIdSchema = z.string().min(1).max(128);

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
