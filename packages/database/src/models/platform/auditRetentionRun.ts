import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';

import {
  type NewPlatformAuditRetentionRun,
  type PlatformAuditRetentionCounts,
  type PlatformAuditRetentionMode,
  type PlatformAuditRetentionRunItem,
  platformAuditRetentionRuns,
  type PlatformAuditRetentionRunStatus,
  type PlatformAuditRetentionScope,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import {
  clampListLimit,
  encodeCreatedAtCursor as encodeCursor,
  parseCreatedAtCursor as parseCursor,
} from './cursor';

export type {
  PlatformAuditRetentionCounts,
  PlatformAuditRetentionMode,
  PlatformAuditRetentionRunItem,
  PlatformAuditRetentionScope,
};

/** Stored scopes only — `all` is a service-layer fan-out, never persisted. */
const STORED_SCOPES: readonly PlatformAuditRetentionScope[] = [
  'operation_logs',
  'conversations',
  'export_artifacts',
];

export interface CreatePlatformAuditRetentionRunParams {
  cutoffAt: Date;
  /** Soft link to platform_jobs.id (unique when set). */
  jobId?: string | null;
  mode: PlatformAuditRetentionMode;
  /** Policy revision snapshot at create time. */
  policyRevision: number;
  /** Required actor for accountability. */
  requestedBy: string;
  /** Single typed scope — never `all`. */
  scope: PlatformAuditRetentionScope;
}

export interface ListPlatformAuditRetentionRunParams {
  /** Composite cursor `${createdAt.toISOString()}|${id}` (desc). */
  cursor?: string;
  /** Clamped to 1..200 (default 50). */
  limit?: number;
  mode?: PlatformAuditRetentionMode;
  requestedBy?: string;
  scope?: PlatformAuditRetentionScope;
  status?: PlatformAuditRetentionRunStatus;
}

export interface UpdatePlatformAuditRetentionProgressParams {
  counts?: PlatformAuditRetentionCounts;
  /** When true, also flips status to running and stamps startedAt once. */
  markRunning?: boolean;
  progressDone?: number;
  progressTotal?: number | null;
}

/** Function declaration required for assertion narrowing (TS2775). */
function assertStoredScope(scope: string): asserts scope is PlatformAuditRetentionScope {
  if (!(STORED_SCOPES as readonly string[]).includes(scope)) {
    throw new Error(
      `Invalid retention scope "${scope}": stored runs must use a single scope (operation_logs | conversations | export_artifacts), not "all"`,
    );
  }
}

/**
 * Retention dry-run / execute run repository with progress tracking.
 * Scope is single-typed only (no stored `all`); cancel is supported.
 */
export class PlatformAuditRetentionRunModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  create = async (
    params: CreatePlatformAuditRetentionRunParams,
  ): Promise<PlatformAuditRetentionRunItem> => {
    assertStoredScope(params.scope);
    if (!params.requestedBy) {
      throw new Error('requestedBy is required for platform audit retention runs');
    }
    if (params.policyRevision == null || params.policyRevision < 0) {
      throw new Error('policyRevision is required and must be >= 0');
    }

    const values: NewPlatformAuditRetentionRun = {
      counts: {},
      cutoffAt: params.cutoffAt,
      jobId: params.jobId ?? null,
      mode: params.mode,
      policyRevision: params.policyRevision,
      requestedBy: params.requestedBy,
      scope: params.scope,
      status: 'pending',
    };
    const [row] = await this.db.insert(platformAuditRetentionRuns).values(values).returning();
    if (!row) {
      throw new Error('Failed to create platform audit retention run');
    }
    return row;
  };

  get = async (id: string): Promise<PlatformAuditRetentionRunItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAuditRetentionRuns)
      .where(eq(platformAuditRetentionRuns.id, id))
      .limit(1);
    return row;
  };

  /**
   * Soft-link a platform_jobs row after enqueue.
   * Allows pending rows with null jobId, or re-affirming the same jobId.
   */
  setJobId = async (
    id: string,
    jobId: string,
  ): Promise<PlatformAuditRetentionRunItem | undefined> => {
    if (!jobId) throw new Error('jobId is required');
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditRetentionRuns)
      .set({ jobId, updatedAt: now })
      .where(
        and(
          eq(platformAuditRetentionRuns.id, id),
          eq(platformAuditRetentionRuns.status, 'pending'),
          or(isNull(platformAuditRetentionRuns.jobId), eq(platformAuditRetentionRuns.jobId, jobId)),
        ),
      )
      .returning();
    return row;
  };

  list = async (
    params: ListPlatformAuditRetentionRunParams = {},
  ): Promise<{ items: PlatformAuditRetentionRunItem[]; nextCursor: string | null }> => {
    const limit = clampListLimit(params.limit);
    const conditions = [];

    if (params.mode) conditions.push(eq(platformAuditRetentionRuns.mode, params.mode));
    if (params.scope) conditions.push(eq(platformAuditRetentionRuns.scope, params.scope));
    if (params.status) conditions.push(eq(platformAuditRetentionRuns.status, params.status));
    if (params.requestedBy) {
      conditions.push(eq(platformAuditRetentionRuns.requestedBy, params.requestedBy));
    }

    const parsed = parseCursor(params.cursor);
    if (parsed) {
      conditions.push(
        or(
          lt(platformAuditRetentionRuns.createdAt, parsed.createdAt),
          and(
            eq(platformAuditRetentionRuns.createdAt, parsed.createdAt),
            lt(platformAuditRetentionRuns.id, parsed.id),
          ),
        )!,
      );
    }

    const rows = await this.db
      .select()
      .from(platformAuditRetentionRuns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(platformAuditRetentionRuns.createdAt), desc(platformAuditRetentionRuns.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  };

  updateProgress = async (
    id: string,
    params: UpdatePlatformAuditRetentionProgressParams,
  ): Promise<PlatformAuditRetentionRunItem | undefined> => {
    const existing = await this.get(id);
    if (!existing) return undefined;
    if (
      existing.status === 'completed' ||
      existing.status === 'failed' ||
      existing.status === 'cancelled'
    ) {
      return undefined;
    }

    const now = new Date();
    const markRunning =
      params.markRunning === true ||
      existing.status === 'pending' ||
      params.progressDone !== undefined;

    const [row] = await this.db
      .update(platformAuditRetentionRuns)
      .set({
        ...(params.counts !== undefined ? { counts: params.counts } : {}),
        ...(params.progressDone !== undefined ? { progressDone: params.progressDone } : {}),
        ...(params.progressTotal !== undefined ? { progressTotal: params.progressTotal } : {}),
        ...(markRunning
          ? {
              startedAt: existing.startedAt ?? now,
              status: 'running' as const,
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditRetentionRuns.id, id),
          or(
            eq(platformAuditRetentionRuns.status, 'pending'),
            eq(platformAuditRetentionRuns.status, 'running'),
          ),
        ),
      )
      .returning();
    return row;
  };

  /**
   * Atomically add non-negative count deltas (F7). Used when object delete +
   * outbox complete commit under a lock while the job lease may already be lost —
   * accounting must still land on the domain row.
   */
  incrementCounts = async (
    id: string,
    delta: PlatformAuditRetentionCounts,
    executor: LobeChatDatabase | Transaction = this.db,
  ): Promise<PlatformAuditRetentionRunItem | undefined> => {
    const existing = await executor
      .select()
      .from(platformAuditRetentionRuns)
      .where(eq(platformAuditRetentionRuns.id, id))
      .limit(1)
      .then((rows) => rows[0]);
    if (!existing) return undefined;
    if (
      existing.status === 'completed' ||
      existing.status === 'failed' ||
      existing.status === 'cancelled'
    ) {
      return undefined;
    }

    const next: PlatformAuditRetentionCounts = { ...existing.counts };
    for (const [key, value] of Object.entries(delta)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      const k = key as keyof PlatformAuditRetentionCounts;
      next[k] = (next[k] ?? 0) + Math.floor(value);
    }

    const now = new Date();
    const [row] = await executor
      .update(platformAuditRetentionRuns)
      .set({
        counts: next,
        // progressDone tracks scanned work, not delete attribution — leave as-is.
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditRetentionRuns.id, id),
          or(
            eq(platformAuditRetentionRuns.status, 'pending'),
            eq(platformAuditRetentionRuns.status, 'running'),
          ),
        ),
      )
      .returning();
    return row;
  };

  complete = async (
    id: string,
    opts?: { counts?: PlatformAuditRetentionCounts },
  ): Promise<PlatformAuditRetentionRunItem | undefined> => {
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditRetentionRuns)
      .set({
        ...(opts?.counts !== undefined ? { counts: opts.counts } : {}),
        error: null,
        finishedAt: now,
        status: 'completed',
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditRetentionRuns.id, id),
          or(
            eq(platformAuditRetentionRuns.status, 'pending'),
            eq(platformAuditRetentionRuns.status, 'running'),
          ),
        ),
      )
      .returning();
    return row;
  };

  fail = async (
    id: string,
    error: { code?: string; message?: string },
  ): Promise<PlatformAuditRetentionRunItem | undefined> => {
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditRetentionRuns)
      .set({
        error,
        finishedAt: now,
        status: 'failed',
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditRetentionRuns.id, id),
          or(
            eq(platformAuditRetentionRuns.status, 'pending'),
            eq(platformAuditRetentionRuns.status, 'running'),
          ),
        ),
      )
      .returning();
    return row;
  };

  /** Cancel a pending or running retention run. */
  cancel = async (id: string): Promise<PlatformAuditRetentionRunItem | undefined> => {
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditRetentionRuns)
      .set({
        finishedAt: now,
        status: 'cancelled',
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditRetentionRuns.id, id),
          or(
            eq(platformAuditRetentionRuns.status, 'pending'),
            eq(platformAuditRetentionRuns.status, 'running'),
          ),
        ),
      )
      .returning();
    return row;
  };

  /** True when the retention run is in a terminal lifecycle state. */
  static isTerminal = (status: PlatformAuditRetentionRunStatus): boolean =>
    status === 'completed' || status === 'failed' || status === 'cancelled';
}
