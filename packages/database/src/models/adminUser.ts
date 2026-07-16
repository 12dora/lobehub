/**
 * Admin user repository (M04).
 *
 * Safe projections only — never selects account password/token/scope or session tokens.
 * Keyset pagination on (createdAt, id) DESC. Search uses escaped prefix patterns on
 * normalized email / email / username (no unbounded leading-wildcard scans).
 *
 * Index evidence:
 * - users_created_at_idx (createdAt) — list order / keyset
 * - users_*_lower_pattern_idx — lower(field) text_pattern_ops for prefix LIKE
 * - users_banned_true_created_at_idx — partial banned filter
 * - auth_session_userId_idx / account_userId_idx — aggregates by user
 */
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

import { account, session } from '../schemas/betterAuth';
import { roles, userRoles } from '../schemas/rbac';
import { users } from '../schemas/user';
import type { LobeChatDatabase, Transaction } from '../type';
import {
  effectivelyActiveSql,
  effectivelyBannedSql,
  isEffectivelyBanned as isEffectivelyBannedShared,
} from '../utils/userBan';

export type AdminUserStatus = 'active' | 'banned';

export interface AdminUserListFilters {
  createdFrom?: Date;
  createdTo?: Date;
  cursor?: string;
  limit?: number;
  /**
   * Already-normalized (trim/lower) search term without LIKE wildcards escaped yet.
   * Repository escapes and applies as prefix-only patterns.
   */
  query?: string;
  role?: string;
  status?: AdminUserStatus;
}

export interface AdminUserListItem {
  avatar: string | null;
  createdAt: Date;
  email: string | null;
  fullName: string | null;
  id: string;
  lastActiveAt: Date | null;
  roles: string[];
  status: AdminUserStatus;
  username: string | null;
}

export interface AdminUserProviderSummary {
  accountIdHint: string | null;
  createdAt: Date | null;
  providerId: string;
}

export interface AdminUserGlobalRoleRow {
  displayName: string | null;
  expiresAt: Date | null;
  id: string;
  name: string;
}

export interface AdminUserSessionSummary {
  createdAt: Date;
  expiresAt: Date;
  id: string;
  ipAddress: string | null;
  updatedAt: Date | null;
  userAgent: string | null;
}

export interface AdminUserDetail {
  avatar: string | null;
  banExpires: Date | null;
  banned: boolean;
  banReason: string | null;
  createdAt: Date;
  email: string | null;
  emailVerified: boolean;
  fullName: string | null;
  id: string;
  lastActiveAt: Date | null;
  providers: AdminUserProviderSummary[];
  roles: AdminUserGlobalRoleRow[];
  sessionCount: number;
  sessions: AdminUserSessionSummary[];
  status: AdminUserStatus;
  username: string | null;
}

export interface AdminUserBanState {
  banExpires: Date | null;
  banned: boolean | null;
  banReason: string | null;
  id: string;
}

/** Composite keyset: `${createdAt.toISOString()}|${id}` (DESC). */
export const encodeAdminUserCursor = (row: { createdAt: Date; id: string }): string =>
  `${row.createdAt.toISOString()}|${row.id}`;

export const parseAdminUserCursor = (
  cursor: string | undefined,
): { createdAt: Date; id: string } | null => {
  if (!cursor) return null;
  const sep = cursor.indexOf('|');
  if (sep <= 0) return null;
  const iso = cursor.slice(0, sep);
  const id = cursor.slice(sep + 1);
  if (!id) return null;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
};

/**
 * Escape `%`, `_`, `\` for prefix-safe ILIKE. Caller appends `%` only.
 */
export const escapeAdminUserLikePattern = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

export const isEffectivelyBanned = isEffectivelyBannedShared;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_SESSION_PREVIEW = 20;

const maskAccountId = (accountId: string | null | undefined): string | null => {
  if (!accountId) return null;
  if (accountId.length <= 4) return '****';
  return `…${accountId.slice(-4)}`;
};

export class AdminUserModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  /**
   * Keyset-paginated admin user list with safe projection + global role names.
   */
  list = async (
    filters: AdminUserListFilters = {},
  ): Promise<{ items: AdminUserListItem[]; nextCursor: string | null }> => {
    const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const conditions: SQL[] = [];
    const now = new Date();

    if (filters.status === 'banned') {
      conditions.push(effectivelyBannedSql());
    } else if (filters.status === 'active') {
      conditions.push(effectivelyActiveSql());
    }

    if (filters.createdFrom) {
      conditions.push(gte(users.createdAt, filters.createdFrom));
    }
    if (filters.createdTo) {
      conditions.push(lte(users.createdAt, filters.createdTo));
    }

    if (filters.query) {
      const escaped = escapeAdminUserLikePattern(filters.query);
      // lower(field) LIKE 'prefix%' — uses users_*_lower_pattern_idx (text_pattern_ops).
      const prefix = `${escaped}%`;
      conditions.push(
        or(
          sql`lower(${users.normalizedEmail}) LIKE ${prefix} ESCAPE '\\'`,
          sql`lower(${users.email}) LIKE ${prefix} ESCAPE '\\'`,
          sql`lower(${users.username}) LIKE ${prefix} ESCAPE '\\'`,
        )!,
      );
    }

    const parsed = parseAdminUserCursor(filters.cursor);
    if (parsed) {
      conditions.push(
        or(
          lt(users.createdAt, parsed.createdAt),
          and(eq(users.createdAt, parsed.createdAt), lt(users.id, parsed.id)),
        )!,
      );
    }

    // Role filter: EXISTS global grant with matching role name (non-expired).
    if (filters.role) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${userRoles}
          INNER JOIN ${roles} ON ${roles.id} = ${userRoles.roleId}
          WHERE ${userRoles.userId} = ${users.id}
            AND ${userRoles.workspaceId} IS NULL
            AND ${roles.workspaceId} IS NULL
            AND ${roles.name} = ${filters.role}
            AND ${roles.isActive} = true
            AND (${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > NOW())
        )`,
      );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db
      .select({
        avatar: users.avatar,
        banExpires: users.banExpires,
        banned: users.banned,
        createdAt: users.createdAt,
        email: users.email,
        fullName: users.fullName,
        id: users.id,
        lastActiveAt: users.lastActiveAt,
        username: users.username,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const roleMap = await this.loadGlobalRoleNames(page.map((r) => r.id));

    const items: AdminUserListItem[] = page.map((row) => ({
      avatar: row.avatar ?? null,
      createdAt: row.createdAt,
      email: row.email ?? null,
      fullName: row.fullName ?? null,
      id: row.id,
      lastActiveAt: row.lastActiveAt ?? null,
      roles: roleMap.get(row.id) ?? [],
      status: isEffectivelyBanned(row, now) ? 'banned' : 'active',
      username: row.username ?? null,
    }));

    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeAdminUserCursor(last) : null;

    return { items, nextCursor };
  };

  findDetailById = async (userId: string): Promise<AdminUserDetail | null> => {
    const [row] = await this.db
      .select({
        avatar: users.avatar,
        banExpires: users.banExpires,
        banReason: users.banReason,
        banned: users.banned,
        createdAt: users.createdAt,
        email: users.email,
        emailVerified: users.emailVerified,
        fullName: users.fullName,
        id: users.id,
        lastActiveAt: users.lastActiveAt,
        username: users.username,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row) return null;

    const now = new Date();
    const [providers, roleRows, sessionCountRow, sessions] = await Promise.all([
      this.listProviderSummaries(userId),
      this.listGlobalRoles(userId),
      this.db
        .select({ value: count() })
        .from(session)
        .where(eq(session.userId, userId))
        .then((r) => r[0]?.value ?? 0),
      this.listSessionSummaries(userId, MAX_SESSION_PREVIEW),
    ]);

    return {
      avatar: row.avatar ?? null,
      banExpires: row.banExpires ?? null,
      banReason: row.banReason ?? null,
      banned: Boolean(row.banned),
      createdAt: row.createdAt,
      email: row.email ?? null,
      emailVerified: Boolean(row.emailVerified),
      fullName: row.fullName ?? null,
      id: row.id,
      lastActiveAt: row.lastActiveAt ?? null,
      providers,
      roles: roleRows,
      sessionCount: Number(sessionCountRow),
      sessions,
      status: isEffectivelyBanned(row, now) ? 'banned' : 'active',
      username: row.username ?? null,
    };
  };

  findBanState = async (userId: string): Promise<AdminUserBanState | null> => {
    const [row] = await this.db
      .select({
        banExpires: users.banExpires,
        banReason: users.banReason,
        banned: users.banned,
        id: users.id,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row ?? null;
  };

  /**
   * Provider name summaries only — never password, tokens, or scope.
   */
  listProviderSummaries = async (userId: string): Promise<AdminUserProviderSummary[]> => {
    const rows = await this.db
      .select({
        accountId: account.accountId,
        createdAt: account.createdAt,
        providerId: account.providerId,
      })
      .from(account)
      .where(eq(account.userId, userId));

    return rows.map((r) => ({
      accountIdHint: maskAccountId(r.accountId),
      createdAt: r.createdAt ?? null,
      providerId: r.providerId,
    }));
  };

  listGlobalRoles = async (userId: string): Promise<AdminUserGlobalRoleRow[]> => {
    return this.db
      .select({
        displayName: roles.displayName,
        expiresAt: userRoles.expiresAt,
        id: roles.id,
        name: roles.name,
      })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(
        and(
          eq(userRoles.userId, userId),
          isNull(userRoles.workspaceId),
          isNull(roles.workspaceId),
          eq(roles.isActive, true),
          sql`(${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > NOW())`,
        ),
      )
      .orderBy(userRoles.createdAt);
  };

  /**
   * Safe session metadata for a target user — never selects `token`.
   */
  listSessionSummaries = async (
    userId: string,
    limit = MAX_SESSION_PREVIEW,
  ): Promise<AdminUserSessionSummary[]> => {
    const rows = await this.db
      .select({
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        id: session.id,
        ipAddress: session.ipAddress,
        updatedAt: session.updatedAt,
        userAgent: session.userAgent,
      })
      .from(session)
      .where(eq(session.userId, userId))
      .orderBy(desc(session.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      id: r.id,
      ipAddress: r.ipAddress ?? null,
      updatedAt: r.updatedAt ?? null,
      userAgent: r.userAgent ?? null,
    }));
  };

  /**
   * Revoke Better Auth sessions for a target user (known auth_sessions model only).
   * Optionally preserve a single session id (actor's current session).
   * Returns number of deleted rows. Never touches accounts / credentials.
   */
  revokeSessionsForUser = async (params: {
    excludeSessionId?: string | null;
    userId: string;
  }): Promise<number> => {
    const conditions = [eq(session.userId, params.userId)];
    if (params.excludeSessionId) {
      conditions.push(ne(session.id, params.excludeSessionId));
    }

    const deleted = await this.db
      .delete(session)
      .where(and(...conditions))
      .returning({ id: session.id });

    return deleted.length;
  };

  /**
   * Assert a Better Auth session row exists and belongs to the user.
   * Returns true if valid; never returns tokens.
   */
  assertSessionBelongsToUser = async (params: {
    sessionId: string;
    userId: string;
  }): Promise<boolean> => {
    const [row] = await this.db
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.id, params.sessionId), eq(session.userId, params.userId)))
      .limit(1);
    return Boolean(row);
  };

  /**
   * Ban/unban user. When banning, advances authInvalidatedAt and clears any
   * retained-session cutoff exception. Does not perform last-super checks.
   */
  setBanned = async (params: {
    banExpires?: Date | null;
    banReason: string;
    banned: boolean;
    /** When true (default on ban), set authInvalidatedAt = now and clear exception. */
    invalidateAuth?: boolean;
    userId: string;
  }): Promise<AdminUserBanState | null> => {
    if (params.banned) {
      const now = new Date();
      const [row] = await this.db
        .update(users)
        .set({
          ...(params.invalidateAuth === false
            ? {}
            : {
                authInvalidatedAt: now,
                authInvalidatedExcludedSessionId: null,
              }),
          banExpires: params.banExpires ?? null,
          banReason: params.banReason,
          banned: true,
          updatedAt: now,
        })
        .where(eq(users.id, params.userId))
        .returning({
          banExpires: users.banExpires,
          banReason: users.banReason,
          banned: users.banned,
          id: users.id,
        });
      return row ?? null;
    }

    const [row] = await this.db
      .update(users)
      .set({
        banExpires: null,
        banReason: null,
        banned: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, params.userId))
      .returning({
        banExpires: users.banExpires,
        banReason: users.banReason,
        banned: users.banned,
        id: users.id,
      });
    return row ?? null;
  };

  /**
   * Advance security epoch. Optionally record a single Better Auth session id
   * exempt from the cutoff (includeCurrent=false). Full revoke passes null.
   * Never rewrites session.createdAt (reauth clock stays original login time).
   */
  invalidateAuth = async (params: {
    at?: Date;
    /** Retained BA session id, or null to clear exception (full revoke / ban). */
    excludedSessionId?: string | null;
    userId: string;
  }): Promise<void> => {
    const at = params.at ?? new Date();
    await this.db
      .update(users)
      .set({
        authInvalidatedAt: at,
        authInvalidatedExcludedSessionId: params.excludedSessionId ?? null,
        updatedAt: at,
      })
      .where(eq(users.id, params.userId));
  };

  private loadGlobalRoleNames = async (userIds: string[]): Promise<Map<string, string[]>> => {
    const map = new Map<string, string[]>();
    if (userIds.length === 0) return map;

    const rows = await this.db
      .select({
        name: roles.name,
        userId: userRoles.userId,
      })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(
        and(
          inArray(userRoles.userId, userIds),
          isNull(userRoles.workspaceId),
          isNull(roles.workspaceId),
          eq(roles.isActive, true),
          sql`(${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > NOW())`,
        ),
      );

    for (const row of rows) {
      const list = map.get(row.userId) ?? [];
      list.push(row.name);
      map.set(row.userId, list);
    }
    return map;
  };
}
