import { and, desc, eq, gt, isNull, lt, lte, or } from 'drizzle-orm';

import {
  type NewPlatformAuditLegalHold,
  type PlatformAuditLegalHoldItem,
  platformAuditLegalHolds,
  type PlatformAuditLegalHoldScopeType,
  type PlatformAuditLegalHoldStatus,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import {
  finalizeAbsentDeletingOutboxes,
  hasDeletingPurgeOutboxes,
  LegalHoldPurgeInProgressError,
  probeAbsentDeletingOutboxes,
} from './auditExport';
import { acquirePlatformAuditRetentionHoldLock } from './auditRetentionHoldLock';
import {
  clampListLimit,
  encodeCreatedAtCursor as encodeCursor,
  parseCreatedAtCursor as parseCursor,
} from './cursor';

export type { PlatformAuditLegalHoldItem };

export interface CreatePlatformAuditLegalHoldParams {
  /** Required actor for accountability. */
  createdBy: string;
  /** Optional auto-expiry; active lookup ignores holds past this instant. */
  expiresAt?: Date | null;
  /**
   * Optional HEAD probe for self-healing stranded `deleting` purge outboxes
   * that intersect this hold (object already gone → finalize, then re-check).
   */
  objectExists?: (storageKey: string) => Promise<boolean>;
  reason: string;
  /**
   * Target id for user/session/topic/workspace.
   * Must be omitted / null for global (stored as NULL — never a `*` sentinel).
   */
  scopeId?: string | null;
  scopeType: PlatformAuditLegalHoldScopeType;
}

export interface ListPlatformAuditLegalHoldParams {
  createdBy?: string;
  /** Composite cursor `${createdAt.toISOString()}|${id}` (desc). */
  cursor?: string;
  /** Clamped to 1..200 (default 50). */
  limit?: number;
  scopeId?: string | null;
  scopeType?: PlatformAuditLegalHoldScopeType;
  status?: PlatformAuditLegalHoldStatus;
}

export interface ReleasePlatformAuditLegalHoldParams {
  /** Required actor who released the hold. */
  releasedBy: string;
  /** Required non-empty release reason. */
  releaseReason: string;
}

export interface PlatformAuditLegalHoldScopeRef {
  scopeId?: string | null;
  scopeType: PlatformAuditLegalHoldScopeType;
}

/**
 * Normalize scope id shape:
 * - global → null (no sentinel)
 * - non-global → non-empty string required
 */
const normalizeScopeId = (
  scopeType: PlatformAuditLegalHoldScopeType,
  scopeId?: string | null,
): string | null => {
  if (scopeType === 'global') {
    if (scopeId != null && scopeId !== '') {
      throw new Error('scopeId must be null for global legal holds');
    }
    return null;
  }
  if (!scopeId) {
    throw new Error(`scopeId is required for legal hold scopeType=${scopeType}`);
  }
  return scopeId;
};

/**
 * Legal hold repository: create / list / get / release / findActiveScopes.
 * Global holds store `scopeId = NULL` (never `*`).
 */
export class PlatformAuditLegalHoldModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  private readonly inTransaction = async <T>(callback: (tx: Transaction) => Promise<T>) => {
    const database = this.db as LobeChatDatabase;
    return typeof database.transaction === 'function'
      ? database.transaction(callback)
      : callback(this.db as Transaction);
  };

  /**
   * Transition expired `active` holds to `released` so the partial unique indexes
   * no longer block a replacement hold for the same scope.
   */
  private releaseExpiredActiveForScope = async (
    tx: Transaction,
    scopeType: PlatformAuditLegalHoldScopeType,
    scopeId: string | null,
    now: Date,
  ): Promise<void> => {
    const scopeMatch =
      scopeId === null
        ? and(
            eq(platformAuditLegalHolds.scopeType, scopeType),
            isNull(platformAuditLegalHolds.scopeId),
          )
        : and(
            eq(platformAuditLegalHolds.scopeType, scopeType),
            eq(platformAuditLegalHolds.scopeId, scopeId),
          );

    await tx
      .update(platformAuditLegalHolds)
      .set({
        releaseReason: 'auto-released: hold expired',
        releasedAt: now,
        releasedBy: 'system:legal-hold-expiry',
        status: 'released',
        updatedAt: now,
      })
      .where(
        and(
          scopeMatch!,
          eq(platformAuditLegalHolds.status, 'active'),
          lte(platformAuditLegalHolds.expiresAt, now),
        ),
      );
  };

  create = async (
    params: CreatePlatformAuditLegalHoldParams,
  ): Promise<PlatformAuditLegalHoldItem> => {
    if (!params.createdBy) {
      throw new Error('createdBy is required for platform audit legal holds');
    }
    if (!params.reason?.trim()) {
      throw new Error('reason is required for platform audit legal holds');
    }
    // Non-future expiresAt is rejected at the admin service boundary. The model
    // still accepts timestamps for fixtures / system repair of already-elapsed rows.

    const scopeId = normalizeScopeId(params.scopeType, params.scopeId);
    const values: NewPlatformAuditLegalHold = {
      createdBy: params.createdBy,
      expiresAt: params.expiresAt ?? null,
      reason: params.reason,
      scopeId,
      scopeType: params.scopeType,
      status: 'active',
    };

    const holdScope = { scopeId, scopeType: params.scopeType };
    // R6: probe S3 **outside** the advisory-lock TX so a slow/hanging HEAD cannot
    // pin every retention purge and other legal-hold creates on one PG connection.
    const provenAbsent = params.objectExists
      ? await probeAbsentDeletingOutboxes(this.db, {
          objectExists: params.objectExists,
          scope: holdScope,
        })
      : [];

    return this.inTransaction(async (tx) => {
      // Serialize with retention deletes; release expired active rows for this scope
      // so the partial unique index does not block a legitimate replacement hold.
      await acquirePlatformAuditRetentionHoldLock(tx);
      // DB-001: refuse only when an *intersecting* purge is in `deleting` — object
      // may already be gone. Finalize only rows proven absent pre-lock (no remote I/O).
      if (provenAbsent.length > 0) {
        await finalizeAbsentDeletingOutboxes(tx, provenAbsent);
      }
      if (await hasDeletingPurgeOutboxes(tx, holdScope)) {
        throw new LegalHoldPurgeInProgressError();
      }
      const now = new Date();
      await this.releaseExpiredActiveForScope(tx, params.scopeType, scopeId, now);

      const [row] = await tx.insert(platformAuditLegalHolds).values(values).returning();
      if (!row) {
        throw new Error('Failed to create platform audit legal hold');
      }
      return row;
    });
  };

  get = async (id: string): Promise<PlatformAuditLegalHoldItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAuditLegalHolds)
      .where(eq(platformAuditLegalHolds.id, id))
      .limit(1);
    return row;
  };

  list = async (
    params: ListPlatformAuditLegalHoldParams = {},
  ): Promise<{ items: PlatformAuditLegalHoldItem[]; nextCursor: string | null }> => {
    const limit = clampListLimit(params.limit);
    const conditions = [];

    if (params.scopeType) conditions.push(eq(platformAuditLegalHolds.scopeType, params.scopeType));
    if (params.scopeId !== undefined) {
      if (params.scopeType === 'global' || params.scopeId === null) {
        conditions.push(isNull(platformAuditLegalHolds.scopeId));
      } else {
        conditions.push(eq(platformAuditLegalHolds.scopeId, params.scopeId));
      }
    }
    if (params.status) {
      conditions.push(eq(platformAuditLegalHolds.status, params.status));
      // "Active" list filter excludes holds that have already elapsed — retention
      // already ignores them, and the service projects them as `expired`.
      if (params.status === 'active') {
        const now = new Date();
        conditions.push(
          or(
            isNull(platformAuditLegalHolds.expiresAt),
            gt(platformAuditLegalHolds.expiresAt, now),
          )!,
        );
      }
    }
    if (params.createdBy) {
      conditions.push(eq(platformAuditLegalHolds.createdBy, params.createdBy));
    }

    const parsed = parseCursor(params.cursor);
    if (parsed) {
      conditions.push(
        or(
          lt(platformAuditLegalHolds.createdAt, parsed.createdAt),
          and(
            eq(platformAuditLegalHolds.createdAt, parsed.createdAt),
            lt(platformAuditLegalHolds.id, parsed.id),
          ),
        )!,
      );
    }

    const rows = await this.db
      .select()
      .from(platformAuditLegalHolds)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(platformAuditLegalHolds.createdAt), desc(platformAuditLegalHolds.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  };

  release = async (
    id: string,
    params: ReleasePlatformAuditLegalHoldParams,
  ): Promise<PlatformAuditLegalHoldItem | undefined> => {
    if (!params.releasedBy) {
      throw new Error('releasedBy is required to release a legal hold');
    }
    if (!params.releaseReason?.trim()) {
      throw new Error('releaseReason is required and must be non-empty');
    }

    const now = new Date();
    const [row] = await this.db
      .update(platformAuditLegalHolds)
      .set({
        releaseReason: params.releaseReason.trim(),
        releasedAt: now,
        releasedBy: params.releasedBy,
        status: 'released',
        updatedAt: now,
      })
      .where(and(eq(platformAuditLegalHolds.id, id), eq(platformAuditLegalHolds.status, 'active')))
      .returning();
    return row;
  };

  /**
   * All active, non-expired legal holds (any scope).
   * Prefer {@link findActiveScopes} / {@link summarizeActiveHoldClasses} for
   * retention batches — this full inventory is only appropriate for small admin
   * views / cold-start indexes.
   */
  listActive = async (): Promise<PlatformAuditLegalHoldItem[]> => {
    const now = new Date();
    const notExpired = or(
      isNull(platformAuditLegalHolds.expiresAt),
      gt(platformAuditLegalHolds.expiresAt, now),
    )!;
    return this.db
      .select()
      .from(platformAuditLegalHolds)
      .where(and(eq(platformAuditLegalHolds.status, 'active'), notExpired))
      .orderBy(desc(platformAuditLegalHolds.createdAt));
  };

  /**
   * Lightweight class presence for export over-skip without loading full inventory.
   * Returns at most one row per scope type (5 classes).
   */
  summarizeActiveHoldClasses = async (): Promise<{
    global: boolean;
    hasSession: boolean;
    hasTopic: boolean;
    hasUser: boolean;
    hasWorkspace: boolean;
  }> => {
    const now = new Date();
    const notExpired = or(
      isNull(platformAuditLegalHolds.expiresAt),
      gt(platformAuditLegalHolds.expiresAt, now),
    )!;
    const rows = await this.db
      .select({
        scopeType: platformAuditLegalHolds.scopeType,
      })
      .from(platformAuditLegalHolds)
      .where(and(eq(platformAuditLegalHolds.status, 'active'), notExpired))
      .groupBy(platformAuditLegalHolds.scopeType);

    const types = new Set(rows.map((r) => r.scopeType));
    return {
      global: types.has('global'),
      hasSession: types.has('session'),
      hasTopic: types.has('topic'),
      hasUser: types.has('user'),
      hasWorkspace: types.has('workspace'),
    };
  };

  /**
   * Returns active holds that match any of the provided scopes, plus any active global hold.
   * Holds with `expiresAt` in the past are excluded.
   * Used by retention / export pipelines to skip protected targets.
   */
  findActiveScopes = async (
    scopes: PlatformAuditLegalHoldScopeRef[] = [],
  ): Promise<PlatformAuditLegalHoldItem[]> => {
    const now = new Date();
    const notExpired = or(
      isNull(platformAuditLegalHolds.expiresAt),
      gt(platformAuditLegalHolds.expiresAt, now),
    )!;

    // Always include global hold coverage (scopeId IS NULL).
    type Pair = { scopeId: string | null; scopeType: PlatformAuditLegalHoldScopeType };
    const pairs: Pair[] = [
      ...scopes.map((scope) => ({
        scopeId: normalizeScopeId(scope.scopeType, scope.scopeId),
        scopeType: scope.scopeType,
      })),
      { scopeId: null, scopeType: 'global' },
    ];

    const key = (p: Pair) => `${p.scopeType}\0${p.scopeId ?? ''}`;
    const unique = [...new Map(pairs.map((p) => [key(p), p])).values()];

    // Match any (scopeType, scopeId) pair. Global uses NULL scopeId — row-value IN
    // with NULL needs IS NULL for the global branch.
    const pairPredicates = unique.map((p) => {
      if (p.scopeId === null) {
        return and(
          eq(platformAuditLegalHolds.scopeType, p.scopeType),
          isNull(platformAuditLegalHolds.scopeId),
        )!;
      }
      return and(
        eq(platformAuditLegalHolds.scopeType, p.scopeType),
        eq(platformAuditLegalHolds.scopeId, p.scopeId),
      )!;
    });

    return this.db
      .select()
      .from(platformAuditLegalHolds)
      .where(and(eq(platformAuditLegalHolds.status, 'active'), notExpired, or(...pairPredicates)))
      .orderBy(desc(platformAuditLegalHolds.createdAt));
  };

  /** Convenience: whether any active hold covers the given scopes (includes global). */
  hasActiveHold = async (scopes: PlatformAuditLegalHoldScopeRef[]): Promise<boolean> => {
    const rows = await this.findActiveScopes(scopes);
    return rows.length > 0;
  };
}
