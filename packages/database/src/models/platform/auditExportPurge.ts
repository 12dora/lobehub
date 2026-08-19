import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import {
  type PlatformAuditExportItem,
  platformAuditExports,
  platformJobs,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import type { DeletingPurgeOutboxRow, ExportErrorPayload } from './auditExportPurgeOutbox';
import {
  ARTIFACT_PURGE_DEFERRED_HOLD_CODE,
  ARTIFACT_PURGE_PENDING_CODE,
  buildPurgeOutboxFields,
  mergePurgeStorageKeys,
  probeAbsentDeletingOutboxes,
  readPurgeOutboxStorageKeys,
} from './auditExportPurgeOutbox';
import { withPlatformAuditRetentionHoldLock } from './auditRetentionHoldLock';
import { clampListLimit } from './cursor';

/**
 * Finalize rows previously proven absent (no remote I/O). Safe under the hold lock.
 */
export const finalizeAbsentDeletingOutboxes = async (
  db: LobeChatDatabase | Transaction,
  rows: DeletingPurgeOutboxRow[],
): Promise<number> => {
  let healed = 0;
  const model = new PlatformAuditExportPurgeOps(db as LobeChatDatabase);
  for (const row of rows) {
    const ok = await model.completeArtifactObjectDelete(
      row.id,
      db,
      row.purgeToken ?? undefined,
      row.storageKey,
    );
    if (ok) healed += 1;
  }
  return healed;
};

/**
 * Self-heal stranded `deleting` rows whose object is already gone (HEAD absent),
 * then re-evaluate. Used by legal-hold create so crash residue does not
 * indefinitely block compliance controls.
 *
 * Prefer {@link probeAbsentDeletingOutboxes} **before** the advisory-lock TX and
 * {@link finalizeAbsentDeletingOutboxes} inside it. This combined helper remains
 * for tests / purge paths; it caps rows and times out each HEAD.
 */
export const reconcileAbsentDeletingOutboxes = async (
  db: LobeChatDatabase | Transaction,
  params: {
    limit?: number;
    objectExists: (storageKey: string) => Promise<boolean>;
    scope?: { scopeId: string | null; scopeType: string };
    timeoutMs?: number;
  },
): Promise<number> => {
  const absent = await probeAbsentDeletingOutboxes(db, params);
  return finalizeAbsentDeletingOutboxes(db, absent);
};

/** Stable code thrown when legal-hold create collides with an intersecting purge. */
export const LEGAL_HOLD_PURGE_IN_PROGRESS_CODE = 'LEGAL_HOLD_PURGE_IN_PROGRESS';

export class LegalHoldPurgeInProgressError extends Error {
  readonly code = LEGAL_HOLD_PURGE_IN_PROGRESS_CODE;
  readonly reason = 'purge_in_progress' as const;
  constructor() {
    super(LEGAL_HOLD_PURGE_IN_PROGRESS_CODE);
    this.name = 'LegalHoldPurgeInProgressError';
  }
}

/**
 * Two-phase artifact purge / outbox ops for platform audit exports.
 * Lifecycle + publication fencing stay on PlatformAuditExportModel.
 */
export class PlatformAuditExportPurgeOps {
  protected readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  /**
   * Durable tombstone + purge outbox claim for retention.
   *
   * Under the caller's TX (hold lock + hold recheck already applied):
   * 1. Read prior private `storageKey`
   * 2. Clear `storageKey` / mark `expired` so the row leaves the candidate set
   * 3. Persist the key on the row as a purge-pending outbox (`error.purgeStorageKey`)
   *
   * The returned key is for callers that still delete immediately; the **safe**
   * path rechecks holds via {@link authorizeArtifactObjectDelete} immediately
   * before the external object delete, then {@link completeArtifactObjectDelete}.
   * A hold that appears after claim must abort/defer — never destroy held evidence.
   */
  claimArtifactStorageForPurge = async (
    id: string,
    executor: LobeChatDatabase | Transaction = this.db,
    purgeRunId?: string,
  ): Promise<{ id: string; storageKey: string } | undefined> => {
    const [existing] = await executor
      .select({
        error: platformAuditExports.error,
        id: platformAuditExports.id,
        status: platformAuditExports.status,
        storageKey: platformAuditExports.storageKey,
      })
      .from(platformAuditExports)
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'completed'),
            eq(platformAuditExports.status, 'expired'),
          ),
          isNotNull(platformAuditExports.storageKey),
        ),
      )
      .limit(1);

    if (!existing?.storageKey) return undefined;

    const now = new Date();
    const [row] = await executor
      .update(platformAuditExports)
      .set({
        // Durable outbox: key survives crash between claim-commit and object delete.
        // Phase 1 only — external delete must not run until purgeStatus='deleting'.
        error: {
          code: ARTIFACT_PURGE_PENDING_CODE,
          // Merge, never replace: a row may already carry orphaned attempt keys from a
          // crashed publication attempt. Dropping them reproduces the SAO-002 defect class.
          ...buildPurgeOutboxFields(
            mergePurgeStorageKeys(
              existing.storageKey,
              readPurgeOutboxStorageKeys(existing.error ?? undefined),
            ),
            {
              code: ARTIFACT_PURGE_PENDING_CODE,
              purgeRunId,
              purgeStatus: 'pending',
            },
          ),
        },
        status: 'expired',
        storageKey: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          isNotNull(platformAuditExports.storageKey),
          or(
            eq(platformAuditExports.status, 'completed'),
            eq(platformAuditExports.status, 'expired'),
          ),
        ),
      )
      .returning({ id: platformAuditExports.id });

    if (!row) return undefined;
    return { id: row.id, storageKey: existing.storageKey };
  };

  /**
   * Final pre-delete authorization for one or more purge outboxes, under the
   * shared retention/hold advisory lock.
   *
   * - Hold free → returns the private storage key (caller may delete the object).
   * - Hold active → restores `storageKey` onto the export (evidence addressable again),
   *   marks outbox deferred, omits from the result (caller must NOT delete).
   *
   * Prefer {@link purgeArtifactObjectsUnderHoldLock} when the external object
   * delete must stay serialized with hold creation (no authorize→delete race).
   */
  authorizeArtifactObjectDeletes = async (
    ids: string[],
    params: {
      db?: LobeChatDatabase;
      resolveHeldIds: (
        tx: Transaction,
        rows: Array<{
          filterSnapshot: PlatformAuditExportItem['filterSnapshot'];
          id: string;
          kind: PlatformAuditExportItem['kind'];
        }>,
      ) => Promise<Set<string>>;
    },
  ): Promise<Array<{ id: string; storageKey: string }>> => {
    if (ids.length === 0) return [];
    const db = params.db ?? (this.db as LobeChatDatabase);

    return withPlatformAuditRetentionHoldLock(db, async (tx) => {
      const { authorized } = await this.recheckPurgeOutboxesUnderTx(tx, ids, params.resolveHeldIds);
      return authorized;
    });
  };

  /**
   * Phase 1 of durable two-phase purge (DB-001): under the hold advisory lock,
   * recheck holds and commit `purgeStatus='deleting'` + an immutable purge token.
   * **No external object delete runs in this transaction.**
   *
   * Callers must delete objects outside the TX, then {@link finalizeArtifactObjectDeletes}.
   * Legal-hold creates serialize behind the same lock and reject while any row is
   * in `deleting` (evidence may already be gone on a prior crash).
   */
  authorizeAndMarkDeletingUnderHoldLock = async (
    ids: string[],
    params: {
      db?: LobeChatDatabase;
      onObjectDeferredHold?: (tx: Transaction, id: string) => Promise<void>;
      resolveHeldIds: (
        tx: Transaction,
        rows: Array<{
          filterSnapshot: PlatformAuditExportItem['filterSnapshot'];
          id: string;
          kind: PlatformAuditExportItem['kind'];
        }>,
      ) => Promise<Set<string>>;
    },
  ): Promise<{
    authorized: Array<{ id: string; purgeToken: string; storageKey: string }>;
    skippedHold: number;
  }> => {
    if (ids.length === 0) return { authorized: [], skippedHold: 0 };
    const db = params.db ?? (this.db as LobeChatDatabase);

    return withPlatformAuditRetentionHoldLock(db, async (tx) => {
      const { authorized, skippedHold, deferredIds } = await this.recheckPurgeOutboxesUnderTx(
        tx,
        ids,
        params.resolveHeldIds,
      );

      if (params.onObjectDeferredHold) {
        for (const id of deferredIds) {
          await params.onObjectDeferredHold(tx, id);
        }
      }

      const marked: Array<{ id: string; purgeToken: string; storageKey: string }> = [];
      const now = new Date();
      for (const item of authorized) {
        const [existing] = await tx
          .select({ error: platformAuditExports.error, status: platformAuditExports.status })
          .from(platformAuditExports)
          .where(eq(platformAuditExports.id, item.id))
          .limit(1);
        const prior = (existing?.error ?? null) as ExportErrorPayload;
        // Reuse token on crash recovery so an in-flight finalize still matches.
        const purgeToken =
          prior?.purgeStatus === 'deleting' && prior.purgeToken
            ? prior.purgeToken
            : `purg_${item.id}_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        // Keep every known attempt key; primary is the key being deleted now.
        const allKeys = mergePurgeStorageKeys(item.storageKey, readPurgeOutboxStorageKeys(prior));
        const domainCode =
          prior?.code &&
          prior.code !== ARTIFACT_PURGE_PENDING_CODE &&
          prior.code !== ARTIFACT_PURGE_DEFERRED_HOLD_CODE
            ? prior.code
            : ARTIFACT_PURGE_PENDING_CODE;
        const [row] = await tx
          .update(platformAuditExports)
          .set({
            error: {
              ...buildPurgeOutboxFields(allKeys, {
                code: domainCode,
                message: prior?.message,
                purgeRunId: prior?.purgeRunId,
                purgeStatus: 'deleting',
                purgeToken,
              }),
              // Primary key under this authorization epoch is the one we will delete.
              purgeStorageKey: item.storageKey,
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(platformAuditExports.id, item.id),
              // Phase 1: terminal rows + completed-with-orphan-attempt-keys (SAO-002).
              // Do not weaken this to include running — that would race live uploads (R7).
              inArray(platformAuditExports.status, ['expired', 'failed', 'cancelled', 'completed']),
              // Only advance outboxes that still carry this storage key.
              sql`(
                coalesce(${platformAuditExports.error}->>'purgeStorageKey', '') = ${item.storageKey}
                OR coalesce(${platformAuditExports.error}->'purgeStorageKeys', '[]'::jsonb) ? ${item.storageKey}
              )`,
            ),
          )
          .returning({ id: platformAuditExports.id });
        if (row) {
          marked.push({ id: item.id, purgeToken, storageKey: item.storageKey });
        }
      }

      return { authorized: marked, skippedHold };
    });
  };

  /**
   * Phase 2 finalize: after external object delete (or HEAD proving absence),
   * clear the outbox only when the purge token still matches.
   */
  finalizeArtifactObjectDeletes = async (
    items: Array<{ id: string; purgeToken: string; storageKey?: string }>,
    params?: {
      onObjectDeleted?: (tx: Transaction, id: string) => Promise<void>;
    },
  ): Promise<number> => {
    if (items.length === 0) return 0;
    let deleted = 0;
    for (const item of items) {
      const ok = await this.completeArtifactObjectDelete(
        item.id,
        this.db,
        item.purgeToken,
        item.storageKey,
      );
      if (ok) {
        deleted += 1;
        if (params?.onObjectDeleted) {
          // Prefer a short TX so accounting is atomic with outbox clear when possible.
          const database = this.db as LobeChatDatabase;
          if (typeof database.transaction === 'function') {
            await database.transaction(async (tx) => {
              // Re-check token already cleared — onObjectDeleted is best-effort attribute.
              await params.onObjectDeleted!(tx, item.id);
            });
          } else {
            await params.onObjectDeleted(this.db as Transaction, item.id);
          }
        }
      }
    }
    return deleted;
  };

  /**
   * Durable two-phase purge orchestration (DB-001):
   * 1) Under hold lock: recheck + mark deleting + commit
   * 2) Outside TX: external object deletes
   * 3) New statements: finalize outbox (and optional accounting)
   *
   * Optional `objectExists` reconciles crash-after-delete: missing object → finalize.
   */
  purgeArtifactObjectsUnderHoldLock = async (
    ids: string[],
    params: {
      db?: LobeChatDatabase;
      deleteObject: (storageKey: string) => Promise<void>;
      /**
       * When true (or returns true), the object is still present. Used to converge
       * `deleting` rows after a crash mid-delete (HEAD/check). Defaults to assuming
       * delete succeeded only when `deleteObject` does not throw.
       */
      objectExists?: (storageKey: string) => Promise<boolean>;
      /**
       * Called after a successful outbox complete. Prefer attribution that does not
       * re-open the hold lock for long remote I/O.
       */
      onObjectDeleted?: (tx: Transaction, id: string) => Promise<void>;
      onObjectDeferredHold?: (tx: Transaction, id: string) => Promise<void>;
      resolveHeldIds: (
        tx: Transaction,
        rows: Array<{
          filterSnapshot: PlatformAuditExportItem['filterSnapshot'];
          id: string;
          kind: PlatformAuditExportItem['kind'];
        }>,
      ) => Promise<Set<string>>;
    },
  ): Promise<{ deleted: number; skippedHold: number }> => {
    if (ids.length === 0) return { deleted: 0, skippedHold: 0 };

    const phase1 = await this.authorizeAndMarkDeletingUnderHoldLock(ids, {
      db: params.db,
      onObjectDeferredHold: params.onObjectDeferredHold,
      resolveHeldIds: params.resolveHeldIds,
    });

    const finalized: Array<{ id: string; purgeToken: string; storageKey: string }> = [];
    for (const item of phase1.authorized) {
      try {
        await params.deleteObject(item.storageKey);
        finalized.push({
          id: item.id,
          purgeToken: item.purgeToken,
          storageKey: item.storageKey,
        });
      } catch {
        // Leave purgeStatus=deleting for retry / HEAD reconciliation.
        if (params.objectExists) {
          try {
            const stillThere = await params.objectExists(item.storageKey);
            if (!stillThere) {
              // Object already gone — converge to deleted.
              finalized.push({
                id: item.id,
                purgeToken: item.purgeToken,
                storageKey: item.storageKey,
              });
            }
          } catch {
            // keep deleting for retry
          }
        }
      }
    }

    // Finalize outside the hold-lock transaction (and after object destroy).
    let deleted = 0;
    for (const item of finalized) {
      const database = (params.db ?? this.db) as LobeChatDatabase;
      const runFinalize = async (executor: LobeChatDatabase | Transaction) => {
        if (
          await this.completeArtifactObjectDelete(
            item.id,
            executor,
            item.purgeToken,
            item.storageKey,
          )
        ) {
          deleted += 1;
          if (params.onObjectDeleted) {
            await params.onObjectDeleted(executor as Transaction, item.id);
          }
        }
      };
      if (typeof database.transaction === 'function') {
        await database.transaction(async (tx) => {
          await runFinalize(tx);
        });
      } else {
        await runFinalize(database);
      }
    }

    // Incomplete batch: leave remaining `deleting` outboxes and fail the worker so
    // the job retries (F6 flaky delete). Successful deletes above are already durable.
    if (phase1.authorized.length > 0 && deleted < phase1.authorized.length) {
      throw new Error('AUDIT_EXPORT_ARTIFACT_DELETE_FAILED');
    }

    return { deleted, skippedHold: phase1.skippedHold };
  };

  /**
   * Shared hold recheck for pending purge outboxes (caller holds the retention lock TX).
   */
  private recheckPurgeOutboxesUnderTx = async (
    tx: Transaction,
    ids: string[],
    resolveHeldIds: (
      tx: Transaction,
      rows: Array<{
        filterSnapshot: PlatformAuditExportItem['filterSnapshot'];
        id: string;
        kind: PlatformAuditExportItem['kind'];
      }>,
    ) => Promise<Set<string>>,
  ): Promise<{
    authorized: Array<{ id: string; storageKey: string }>;
    deferredIds: string[];
    skippedHold: number;
  }> => {
    const existingRows = await tx
      .select({
        error: platformAuditExports.error,
        filterSnapshot: platformAuditExports.filterSnapshot,
        id: platformAuditExports.id,
        kind: platformAuditExports.kind,
        status: platformAuditExports.status,
        storageKey: platformAuditExports.storageKey,
      })
      .from(platformAuditExports)
      .where(inArray(platformAuditExports.id, ids));

    const pending = existingRows
      .map((row) => {
        const rawKeys = readPurgeOutboxStorageKeys(row.error as ExportErrorPayload);
        // Completed rows publish a live storageKey — never schedule that key for purge.
        const keys =
          row.status === 'completed' && row.storageKey
            ? rawKeys.filter((k) => k !== row.storageKey)
            : rawKeys;
        return keys.length > 0
          ? { ...row, keys, liveStorageKey: row.storageKey, storageKey: keys[0]! }
          : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (pending.length === 0) return { authorized: [], deferredIds: [], skippedHold: 0 };

    const heldIds = await resolveHeldIds(
      tx,
      pending.map((r) => ({
        filterSnapshot: r.filterSnapshot,
        id: r.id,
        kind: r.kind,
      })),
    );

    const authorized: Array<{ id: string; storageKey: string }> = [];
    const deferredIds: string[] = [];
    let skippedHold = 0;
    const now = new Date();

    for (const row of pending) {
      if (heldIds.has(row.id)) {
        const prior = (row.error ?? null) as ExportErrorPayload;
        // Never clobber a committed `deleting` epoch (object may already be gone).
        if (prior?.purgeStatus === 'deleting') {
          skippedHold += 1;
          deferredIds.push(row.id);
          continue;
        }
        // Completed + orphan attempt keys: leave published storageKey and multi-key
        // outbox intact (do not restore first orphan over the live artifact).
        if (row.status === 'completed') {
          skippedHold += 1;
          deferredIds.push(row.id);
          continue;
        }
        // Defer: restore addressable primary key; leave status expired so retention
        // may re-scan once the hold is released (storageKey IS NOT NULL).
        await tx
          .update(platformAuditExports)
          .set({
            error: {
              code: ARTIFACT_PURGE_DEFERRED_HOLD_CODE,
              message: 'legal hold active between claim and object delete',
            },
            storageKey: row.storageKey,
            updatedAt: now,
          })
          .where(
            and(
              eq(platformAuditExports.id, row.id),
              // Guard: do not rewrite a deleting epoch (restore would re-point at a
              // possibly-destroyed object and drop purgeToken).
              sql`coalesce(${platformAuditExports.error}->>'purgeStatus', '') <> 'deleting'`,
            ),
          );
        skippedHold += 1;
        deferredIds.push(row.id);
        continue;
      }
      // Expand every attempt key so multi-key outboxes drain completely.
      for (const storageKey of row.keys) {
        authorized.push({ id: row.id, storageKey });
      }
    }

    return { authorized, deferredIds, skippedHold };
  };

  /**
   * Promote running exports whose platform job was dead-lettered (lease expiry /
   * attempt budget) into terminal failed + durable purge outbox (F6 / DB-002).
   * claimNext can mark the job dead without invoking the export worker cleanup path.
   *
   * **Atomic**: status→failed, storageKey→null, purge outbox key are one UPDATE so a
   * crash cannot leave `failed + storageKey non-null` stranded from both scans.
   */
  reconcileDeadLetterExportArtifacts = async (params?: {
    /** Fallback object key when no upload intent / storageKey was recorded. */
    buildStorageKey: (exportId: string) => string;
    limit?: number;
  }): Promise<number> => {
    if (!params?.buildStorageKey) return 0;
    const limit = clampListLimit(params.limit);

    // Running domain + dead job: worker never got a chance to fail/enqueue outbox.
    const abandoned = await this.db
      .select({
        error: platformAuditExports.error,
        id: platformAuditExports.id,
        storageKey: platformAuditExports.storageKey,
      })
      .from(platformAuditExports)
      .innerJoin(platformJobs, eq(platformAuditExports.jobId, platformJobs.id))
      .where(and(eq(platformAuditExports.status, 'running'), eq(platformJobs.status, 'dead')))
      .orderBy(desc(platformAuditExports.updatedAt), desc(platformAuditExports.id))
      .limit(limit);

    let n = 0;
    const now = new Date();
    for (const row of abandoned) {
      const prior = (row.error ?? null) as ExportErrorPayload;
      // Prefer every recorded attempt key; fallback is attempts/ prefix (not the
      // legacy deterministic filename — attempt keys never write there).
      const known = mergePurgeStorageKeys(row.storageKey, readPurgeOutboxStorageKeys(prior));
      const keys = known.length > 0 ? known : mergePurgeStorageKeys(params.buildStorageKey(row.id));
      // Single conditional UPDATE: no intermediate failed+storageKey state (DB-002).
      const [failed] = await this.db
        .update(platformAuditExports)
        .set({
          error: {
            ...buildPurgeOutboxFields(keys, {
              code: 'EXPORT_FAILED',
              message: prior?.message,
              purgeStatus: 'pending',
            }),
          },
          finishedAt: now,
          status: 'failed',
          storageKey: null,
          updatedAt: now,
        })
        .where(and(eq(platformAuditExports.id, row.id), eq(platformAuditExports.status, 'running')))
        .returning({ id: platformAuditExports.id });
      if (failed) n += 1;
    }
    return n;
  };

  /**
   * Durable purge outbox rows left after claim (storageKey cleared) when the
   * worker crashed or object delete failed before {@link completeArtifactObjectDelete}.
   * Also includes **completed** rows that still carry orphan attempt keys after a
   * crash→retry→success publication (SAO-002) — those keep the live `storageKey`.
   * Candidate scan requires storageKey IS NOT NULL, so failed/cancelled outboxes
   * (storageKey null) must be drained separately from retention candidates.
   */
  listPendingArtifactPurges = async (params?: {
    limit?: number;
  }): Promise<Array<{ id: string; purgeRunId: string | null; storageKey: string }>> => {
    const limit = clampListLimit(params?.limit);
    const rows = await this.db
      .select({
        error: platformAuditExports.error,
        id: platformAuditExports.id,
        status: platformAuditExports.status,
        storageKey: platformAuditExports.storageKey,
      })
      .from(platformAuditExports)
      .where(
        and(
          or(
            // Classic outbox: terminal + storageKey cleared.
            and(
              inArray(platformAuditExports.status, ['expired', 'failed', 'cancelled']),
              isNull(platformAuditExports.storageKey),
            ),
            // SAO-002 success path: completed still holds orphan attempt keys in error.
            eq(platformAuditExports.status, 'completed'),
          ),
          // Outbox present: primary key and/or keys array.
          sql`(
            coalesce(${platformAuditExports.error}->>'purgeStorageKey', '') <> ''
            OR jsonb_typeof(${platformAuditExports.error}->'purgeStorageKeys') = 'array'
               AND jsonb_array_length(${platformAuditExports.error}->'purgeStorageKeys') > 0
          )`,
        ),
      )
      .orderBy(desc(platformAuditExports.updatedAt), desc(platformAuditExports.id))
      .limit(limit);

    // One entry per export (primary purge key). Phase-1 recheck expands all attempt keys.
    // For completed rows, never schedule the live published storageKey.
    return rows
      .map((row) => {
        const raw = readPurgeOutboxStorageKeys(row.error as ExportErrorPayload);
        const keys =
          row.status === 'completed' && row.storageKey
            ? raw.filter((k) => k !== row.storageKey)
            : raw;
        const storageKey = keys[0] ?? null;
        const error = row.error as ExportErrorPayload;
        return storageKey
          ? { id: row.id, purgeRunId: error?.purgeRunId ?? null, storageKey }
          : null;
      })
      .filter(
        (row): row is { id: string; purgeRunId: string | null; storageKey: string } => row !== null,
      );
  };

  /**
   * Durable purge outbox for failed / cancelled / expired exports that may still
   * hold a private object (deterministic key or cleared storageKey).
   * Retention {@link listPendingArtifactPurges} drains these until delete confirms.
   */
  enqueueArtifactObjectPurge = async (
    id: string,
    storageKey: string,
    executor: LobeChatDatabase | Transaction = this.db,
  ): Promise<boolean> => {
    if (!storageKey) return false;
    const now = new Date();
    // Preserve domain failure code/message when attaching the purge key (tests + ops).
    const [existing] = await executor
      .select({ error: platformAuditExports.error })
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, id))
      .limit(1);
    const prior = (existing?.error ?? null) as ExportErrorPayload;
    // Append — never refuse when a different attempt key is already recorded.
    const allKeys = mergePurgeStorageKeys(readPurgeOutboxStorageKeys(prior), storageKey);
    const domainCode =
      prior?.code && prior.code !== ARTIFACT_PURGE_PENDING_CODE
        ? prior.code
        : ARTIFACT_PURGE_PENDING_CODE;

    const [row] = await executor
      .update(platformAuditExports)
      .set({
        error: {
          ...buildPurgeOutboxFields(allKeys, {
            code: domainCode,
            message: prior?.message,
            purgeStatus: prior?.purgeStatus === 'deleting' ? 'deleting' : 'pending',
            purgeToken: prior?.purgeToken,
          }),
        },
        storageKey: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'failed'),
            eq(platformAuditExports.status, 'cancelled'),
            eq(platformAuditExports.status, 'expired'),
            // Completed is allowed only for ownership-proven cancel paths; workers
            // that lost publication must not purge a winner's key via this helper.
            eq(platformAuditExports.status, 'completed'),
          ),
        ),
      )
      .returning({ id: platformAuditExports.id });
    return Boolean(row);
  };

  /**
   * Mark purge outbox complete **only** after a successful external object delete.
   * When `purgeToken` is provided, finalize is fenced to that authorization epoch
   * so a stale completer cannot clear a newer outbox.
   * When `deletedStorageKey` is provided (or the primary key is known), only that
   * key is removed; remaining attempt keys stay pending.
   * No-op when the outbox is already cleared or was deferred/restored.
   */
  completeArtifactObjectDelete = async (
    id: string,
    executor: LobeChatDatabase | Transaction = this.db,
    purgeToken?: string,
    deletedStorageKey?: string,
  ): Promise<boolean> => {
    const [existing] = await executor
      .select({
        error: platformAuditExports.error,
        id: platformAuditExports.id,
      })
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, id))
      .limit(1);

    const prior = existing?.error as ExportErrorPayload | undefined;
    const keys = readPurgeOutboxStorageKeys(prior);
    if (keys.length === 0) return false;
    if (purgeToken && prior?.purgeToken && prior.purgeToken !== purgeToken) return false;

    const removeKey = deletedStorageKey ?? prior?.purgeStorageKey ?? keys[0]!;
    const remaining = keys.filter((k) => k !== removeKey);

    // Keep domain fail/cancel codes for operators & tests.
    const domainCode =
      prior?.code && prior.code !== ARTIFACT_PURGE_PENDING_CODE ? prior.code : undefined;
    const domainMessage = domainCode ? prior?.message : undefined;

    // If more attempt keys remain, keep the authorization epoch (token + deleting)
    // so a multi-key purge batch can finalize each key with the same fence.
    const nextError: ExportErrorPayload =
      remaining.length > 0
        ? {
            ...buildPurgeOutboxFields(remaining, {
              code: domainCode ?? ARTIFACT_PURGE_PENDING_CODE,
              message: domainMessage,
              purgeRunId: prior?.purgeRunId,
              purgeStatus: prior?.purgeStatus === 'deleting' ? 'deleting' : 'pending',
              purgeToken: prior?.purgeStatus === 'deleting' ? prior.purgeToken : undefined,
            }),
          }
        : domainCode
          ? { code: domainCode, message: domainMessage }
          : null;

    const [row] = await executor
      .update(platformAuditExports)
      .set({
        error: nextError,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          // Only clear while a purge key is still present (lost races stay safe).
          sql`(
            coalesce(${platformAuditExports.error}->>'purgeStorageKey', '') <> ''
            OR jsonb_typeof(${platformAuditExports.error}->'purgeStorageKeys') = 'array'
          )`,
          purgeToken
            ? sql`coalesce(${platformAuditExports.error}->>'purgeToken', '') = ${purgeToken}`
            : undefined,
        ),
      )
      .returning({ id: platformAuditExports.id });

    return Boolean(row);
  };
}
