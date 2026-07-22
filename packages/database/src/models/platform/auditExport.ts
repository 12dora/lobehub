import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';

import {
  type NewPlatformAuditExport,
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportItem,
  type PlatformAuditExportKind,
  platformAuditExports,
  type PlatformAuditExportStatus,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export type {
  PlatformAuditExportFilterSnapshot,
  PlatformAuditExportItem,
  PlatformAuditExportKind,
  PlatformAuditExportStatus,
};

export interface CreatePlatformAuditExportParams {
  filterSnapshot?: PlatformAuditExportFilterSnapshot;
  /** Soft link to platform_jobs.id (unique when set). */
  includesMessageBodies?: boolean;
  jobId?: string | null;
  kind: PlatformAuditExportKind;
  /** Required actor for accountability. */
  requestedBy: string;
}

export interface ListPlatformAuditExportParams {
  /** Composite cursor `${createdAt.toISOString()}|${id}` (desc). */
  cursor?: string;
  kind?: PlatformAuditExportKind;
  /** Clamped to 1..200 (default 50). */
  limit?: number;
  requestedBy?: string;
  status?: PlatformAuditExportStatus;
}

/**
 * Complete an export: private storage key + checksum + expiresAt are required
 * (DB check + model contract). Never accept signed URLs.
 */
export interface CompletePlatformAuditExportParams {
  artifactBytes?: number | null;
  artifactChecksum: string;
  expiresAt: Date;
  rowCount?: number | null;
  /** Private object storage key — never a signed download URL. */
  storageKey: string;
}

const TERMINAL_EXPORT_STATUSES: readonly PlatformAuditExportStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'expired',
];

const clampListLimit = (limit?: number): number =>
  Math.min(Math.max(Math.floor(limit ?? 50), 1), 200);

const encodeCursor = (row: Pick<PlatformAuditExportItem, 'createdAt' | 'id'>): string =>
  `${row.createdAt.toISOString()}|${row.id}`;

const parseCursor = (cursor: string | undefined): { createdAt: Date; id: string } | null => {
  if (!cursor?.includes('|')) return null;
  const [iso, id] = cursor.split('|');
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
};

/**
 * Admin audit export repository: create → running → complete/fail/cancel/expired.
 * Artifacts are referenced only via private `storageKey` (never `artifactUrl`).
 */
export class PlatformAuditExportModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  create = async (params: CreatePlatformAuditExportParams): Promise<PlatformAuditExportItem> => {
    if (!params.requestedBy) {
      throw new Error('requestedBy is required for platform audit exports');
    }
    const values: NewPlatformAuditExport = {
      filterSnapshot: params.filterSnapshot ?? {},
      includesMessageBodies: params.includesMessageBodies ?? false,
      jobId: params.jobId ?? null,
      kind: params.kind,
      requestedBy: params.requestedBy,
      status: 'pending',
    };
    const [row] = await this.db.insert(platformAuditExports).values(values).returning();
    if (!row) {
      throw new Error('Failed to create platform audit export');
    }
    return row;
  };

  get = async (id: string): Promise<PlatformAuditExportItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, id))
      .limit(1);
    return row;
  };

  /**
   * Soft-link a platform_jobs row after enqueue.
   * Allows pending rows with null jobId, or re-affirming the same jobId.
   */
  setJobId = async (id: string, jobId: string): Promise<PlatformAuditExportItem | undefined> => {
    if (!jobId) throw new Error('jobId is required');
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({ jobId, updatedAt: now })
      .where(
        and(
          eq(platformAuditExports.id, id),
          eq(platformAuditExports.status, 'pending'),
          or(isNull(platformAuditExports.jobId), eq(platformAuditExports.jobId, jobId)),
        ),
      )
      .returning();
    return row;
  };

  list = async (
    params: ListPlatformAuditExportParams = {},
  ): Promise<{ items: PlatformAuditExportItem[]; nextCursor: string | null }> => {
    const limit = clampListLimit(params.limit);
    const conditions = [];

    if (params.kind) conditions.push(eq(platformAuditExports.kind, params.kind));
    if (params.status) conditions.push(eq(platformAuditExports.status, params.status));
    if (params.requestedBy) {
      conditions.push(eq(platformAuditExports.requestedBy, params.requestedBy));
    }

    const parsed = parseCursor(params.cursor);
    if (parsed) {
      conditions.push(
        or(
          lt(platformAuditExports.createdAt, parsed.createdAt),
          and(
            eq(platformAuditExports.createdAt, parsed.createdAt),
            lt(platformAuditExports.id, parsed.id),
          ),
        )!,
      );
    }

    const rows = await this.db
      .select()
      .from(platformAuditExports)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(platformAuditExports.createdAt), desc(platformAuditExports.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  };

  markRunning = async (
    id: string,
    opts?: { jobId?: string | null },
  ): Promise<PlatformAuditExportItem | undefined> => {
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        ...(opts?.jobId !== undefined ? { jobId: opts.jobId } : {}),
        error: null,
        startedAt: now,
        status: 'running',
        updatedAt: now,
      })
      .where(and(eq(platformAuditExports.id, id), eq(platformAuditExports.status, 'pending')))
      .returning();
    return row;
  };

  complete = async (
    id: string,
    params: CompletePlatformAuditExportParams,
  ): Promise<PlatformAuditExportItem | undefined> => {
    if (!params.artifactChecksum) {
      throw new Error('artifactChecksum is required to complete an export');
    }
    if (!params.storageKey) {
      throw new Error('storageKey is required to complete an export (private key, never a URL)');
    }
    if (!(params.expiresAt instanceof Date) || Number.isNaN(params.expiresAt.getTime())) {
      throw new Error('expiresAt is required to complete an export');
    }

    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        artifactBytes: params.artifactBytes ?? null,
        artifactChecksum: params.artifactChecksum,
        error: null,
        expiresAt: params.expiresAt,
        finishedAt: now,
        rowCount: params.rowCount ?? null,
        status: 'completed',
        storageKey: params.storageKey,
        updatedAt: now,
      })
      .where(and(eq(platformAuditExports.id, id), eq(platformAuditExports.status, 'running')))
      .returning();
    return row;
  };

  fail = async (
    id: string,
    error: { code?: string; message?: string },
  ): Promise<PlatformAuditExportItem | undefined> => {
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        error,
        finishedAt: now,
        status: 'failed',
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'pending'),
            eq(platformAuditExports.status, 'running'),
          ),
        ),
      )
      .returning();
    return row;
  };

  cancel = async (id: string): Promise<PlatformAuditExportItem | undefined> => {
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        finishedAt: now,
        status: 'cancelled',
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'pending'),
            eq(platformAuditExports.status, 'running'),
          ),
        ),
      )
      .returning();
    return row;
  };

  /**
   * Transition a completed (or still open) export to `expired`.
   * Idempotent when already expired; refuses other terminal states.
   */
  expired = async (id: string): Promise<PlatformAuditExportItem | undefined> => {
    const existing = await this.get(id);
    if (!existing) return undefined;
    if (existing.status === 'expired') return existing;
    if (existing.status === 'failed' || existing.status === 'cancelled') return undefined;

    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        finishedAt: existing.finishedAt ?? now,
        status: 'expired',
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'completed'),
            eq(platformAuditExports.status, 'pending'),
            eq(platformAuditExports.status, 'running'),
          ),
        ),
      )
      .returning();
    return row;
  };

  /**
   * Retention artifact clear: mark expired and clear private storageKey while
   * retaining checksum / bytes / filter snapshot / metadata history.
   * Preserves original finishedAt (completion time) — never overwrites it.
   * Accepts completed or already-expired rows (idempotent storageKey clear).
   */
  clearArtifactStorage = async (id: string): Promise<PlatformAuditExportItem | undefined> => {
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        status: 'expired',
        storageKey: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'completed'),
            eq(platformAuditExports.status, 'expired'),
          ),
        ),
      )
      .returning();
    return row;
  };

  /** True when the export is in a terminal lifecycle state. */
  static isTerminal = (status: PlatformAuditExportStatus): boolean =>
    TERMINAL_EXPORT_STATUSES.includes(status);
}
