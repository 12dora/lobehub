import { sql } from 'drizzle-orm';

import {
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportKind,
  platformAuditExports,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { holdIntersectsExportArtifact } from './auditExportHolds';

/** Durable outbox marker: private key pending external object delete. */
export const ARTIFACT_PURGE_PENDING_CODE = 'ARTIFACT_PURGE_PENDING';
/** Outbox aborted because a legal hold appeared after claim-commit. */
export const ARTIFACT_PURGE_DEFERRED_HOLD_CODE = 'ARTIFACT_PURGE_DEFERRED_HOLD';

/**
 * Purge outbox / publication fencing payload on `platform_audit_exports.error`.
 * Two-phase purge: pending → deleting (DB commit) → external delete → clear.
 *
 * Multi-attempt publication uses attempt-unique object keys. The outbox therefore
 * carries **every** known key (`purgeStorageKeys`, append-on-record) so a rebind
 * cannot orphan an earlier attempt's object. `purgeStorageKey` is the primary key
 * currently in the purge epoch (backward compatible with single-key scans).
 */
export type ExportErrorPayload = {
  /** Fencing token for the active publication attempt (running only). */
  attemptToken?: string;
  code?: string;
  message?: string;
  /** Two-phase purge state after claim / authorize. */
  purgeStatus?: 'pending' | 'deleting';
  /** Primary key currently authorized / pending purge. */
  purgeStorageKey?: string;
  /** All attempt keys that may still exist (append-on-record). */
  purgeStorageKeys?: string[];
  /** Retention run that durably claimed this object for purge. */
  purgeRunId?: string;
  /** Immutable token for the current purge authorization epoch. */
  purgeToken?: string;
} | null;

/** Merge storage keys in first-seen order (deduped). */
export const mergePurgeStorageKeys = (
  ...sources: Array<string | string[] | null | undefined>
): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    const list = Array.isArray(src) ? src : [src];
    for (const key of list) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
};

/**
 * All purge-outbox keys on a row (array + legacy single field).
 */
export const readPurgeOutboxStorageKeys = (error: ExportErrorPayload | undefined): string[] =>
  mergePurgeStorageKeys(error?.purgeStorageKeys, error?.purgeStorageKey);

/**
 * Primary purge-outbox key (first known key). Present when any key is set —
 * domain failure code may still be retained alongside the outbox.
 */
export const readPurgeOutboxStorageKey = (error: ExportErrorPayload | undefined): string | null => {
  const keys = readPurgeOutboxStorageKeys(error);
  return keys[0] ?? null;
};

/** Build the purge-outbox slice of `error` for a known set of keys. */
export const buildPurgeOutboxFields = (
  keys: string[],
  opts?: {
    code?: string;
    message?: string;
    purgeRunId?: string;
    purgeStatus?: 'pending' | 'deleting';
    purgeToken?: string;
  },
): Pick<
  NonNullable<ExportErrorPayload>,
  | 'code'
  | 'message'
  | 'purgeRunId'
  | 'purgeStatus'
  | 'purgeStorageKey'
  | 'purgeStorageKeys'
  | 'purgeToken'
> => {
  const unique = mergePurgeStorageKeys(keys);
  if (unique.length === 0) {
    return {
      code: opts?.code,
      message: opts?.message,
    };
  }
  return {
    code: opts?.code,
    message: opts?.message,
    purgeRunId: opts?.purgeRunId,
    purgeStatus: opts?.purgeStatus ?? 'pending',
    purgeStorageKey: unique[0],
    purgeStorageKeys: unique,
    ...(opts?.purgeToken ? { purgeToken: opts.purgeToken } : {}),
  };
};

export const readAttemptToken = (error: ExportErrorPayload | undefined): string | null => {
  const token = error?.attemptToken;
  return token && token.length > 0 ? token : null;
};

export type DeletingPurgeOutboxRow = {
  filterSnapshot: PlatformAuditExportFilterSnapshot | null;
  id: string;
  kind: PlatformAuditExportKind;
  purgeToken: string | null;
  storageKey: string;
};

/** List exports currently in purgeStatus=deleting (object may already be gone). */
export const listDeletingPurgeOutboxes = async (
  db: LobeChatDatabase | Transaction,
  limit = 200,
): Promise<DeletingPurgeOutboxRow[]> => {
  const rows = await db
    .select({
      error: platformAuditExports.error,
      filterSnapshot: platformAuditExports.filterSnapshot,
      id: platformAuditExports.id,
      kind: platformAuditExports.kind,
    })
    .from(platformAuditExports)
    .where(sql`coalesce(${platformAuditExports.error}->>'purgeStatus', '') = 'deleting'`)
    .limit(Math.max(1, Math.min(500, limit)));

  const out: DeletingPurgeOutboxRow[] = [];
  for (const row of rows) {
    const err = row.error as ExportErrorPayload;
    const storageKey = readPurgeOutboxStorageKey(err);
    if (!storageKey) continue;
    out.push({
      // Schema column is notNull; keep `| null` on the public type for callers that
      // treat missing snapshots defensively without widening the select result.
      filterSnapshot: row.filterSnapshot ?? null,
      id: row.id,
      kind: row.kind,
      purgeToken: err?.purgeToken ?? null,
      storageKey,
    });
  }
  return out;
};

/**
 * True when a `deleting` purge outbox intersects the candidate hold scope.
 * Pass `scopeType`/`scopeId` to avoid blocking unrelated holds (DB-001).
 * When scope is omitted, any deleting row matches (legacy global check).
 */
export const hasDeletingPurgeOutboxes = async (
  db: LobeChatDatabase | Transaction,
  scope?: { scopeId: string | null; scopeType: string },
): Promise<boolean> => {
  const rows = await listDeletingPurgeOutboxes(db);
  if (rows.length === 0) return false;
  if (!scope) return true;
  return rows.some((row) => holdIntersectsExportArtifact(scope, row.kind, row.filterSnapshot));
};

/** Max stranded `deleting` rows healed per legal-hold create (bounds lock hold). */
export const RECONCILE_ABSENT_DELETING_LIMIT = 16;
/** Per-object HEAD budget while reconciling (ms). Timeout → leave row for retry. */
export const RECONCILE_OBJECT_EXISTS_TIMEOUT_MS = 1500;

/**
 * Race a HEAD probe against a short timeout so a hanging S3 cannot pin callers.
 * Rejects on timeout (caller treats like HEAD failure — leave outbox pending).
 */
export const withObjectExistsTimeout = async (
  probe: () => Promise<boolean>,
  timeoutMs: number = RECONCILE_OBJECT_EXISTS_TIMEOUT_MS,
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('OBJECT_EXISTS_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Probe intersecting `deleting` outboxes **outside** the hold advisory lock.
 * Returns rows whose object is already gone so the locked path can finalize
 * without network I/O (R6 — S3 must not pin `pg_advisory_xact_lock`).
 */
export const probeAbsentDeletingOutboxes = async (
  db: LobeChatDatabase | Transaction,
  params: {
    limit?: number;
    objectExists: (storageKey: string) => Promise<boolean>;
    scope?: { scopeId: string | null; scopeType: string };
    timeoutMs?: number;
  },
): Promise<DeletingPurgeOutboxRow[]> => {
  const limit = Math.max(
    1,
    Math.min(RECONCILE_ABSENT_DELETING_LIMIT, params.limit ?? RECONCILE_ABSENT_DELETING_LIMIT),
  );
  const timeoutMs = params.timeoutMs ?? RECONCILE_OBJECT_EXISTS_TIMEOUT_MS;
  const rows = await listDeletingPurgeOutboxes(db, limit);
  const absent: DeletingPurgeOutboxRow[] = [];
  for (const row of rows) {
    if (params.scope && !holdIntersectsExportArtifact(params.scope, row.kind, row.filterSnapshot)) {
      continue;
    }
    try {
      const stillThere = await withObjectExistsTimeout(
        () => params.objectExists(row.storageKey),
        timeoutMs,
      );
      if (!stillThere) absent.push(row);
    } catch {
      // HEAD failure / timeout — leave for retry; do not finalize blindly.
    }
  }
  return absent;
};
