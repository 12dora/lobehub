import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, timestamptz, updatedAt } from '../_helpers';
import type { PlatformAuditResult } from './common';

/** Deterministic singleton id for platform audit policy. */
export const PLATFORM_AUDIT_POLICY_ID = 'global';

/** How conversation / message body content may be accessed by admin audit tooling. */
export type PlatformAuditContentAccessMode = 'disabled' | 'metadata_only' | 'content_allowed';

/** Redaction aggressiveness applied before diffs / exports leave the system. */
export type PlatformAuditRedactionProfile = 'strict' | 'standard';

/**
 * Numeric / enum column defaults for the audit policy singleton.
 * Shared by the pgTable `.default(...)` declarations and model `getOrCreate` inserts.
 */
export const PLATFORM_AUDIT_POLICY_DEFAULTS = {
  contentAccessMode: 'metadata_only' as const satisfies PlatformAuditContentAccessMode,
  conversationRetentionDays: 180,
  exportArtifactRetentionDays: 7,
  maxExportRows: 50_000,
  maxListWindowDays: 90,
  messageBodyInExport: false,
  operationLogRetentionDays: 365,
  redactionProfile: 'strict' as const satisfies PlatformAuditRedactionProfile,
  revision: 0,
};

/** Export job kinds supported by the admin audit export pipeline. */
export type PlatformAuditExportKind = 'operation_logs' | 'conversations' | 'user_timeline';

/** Lifecycle of an export artifact job. */
export type PlatformAuditExportStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';

/** Retention runner execution mode. */
export type PlatformAuditRetentionMode = 'dry_run' | 'execute';

/**
 * What retention considers when scanning for purge candidates.
 * Single-scope only — a later service may fan `all` into three independent runs.
 */
export type PlatformAuditRetentionScope = 'operation_logs' | 'conversations' | 'export_artifacts';

/** Lifecycle of a retention run. */
export type PlatformAuditRetentionRunStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Legal hold target kinds (global has no scope id — stored as NULL). */
export type PlatformAuditLegalHoldScopeType = 'user' | 'session' | 'topic' | 'workspace' | 'global';

/** Legal hold lifecycle. */
export type PlatformAuditLegalHoldStatus = 'active' | 'released';

/**
 * Typed filter snapshot frozen at export create time.
 * Later workers must honor this snapshot, not re-read live query params.
 * Policy caps (revision / max rows / artifact retention) are frozen here so
 * mid-flight policy edits cannot change the contract of an in-flight export.
 */
export interface PlatformAuditExportFilterSnapshot {
  action?: string;
  actions?: string[];
  actorUserId?: string;
  actorUserIds?: string[];
  /**
   * Artifact retention days frozen from policy at create (non-secret; public).
   * Worker uses this to compute expiresAt rather than live policy.
   */
  exportArtifactRetentionDays?: number;
  /** Inclusive lower bound ISO-8601 (frozen at create). */
  from?: string;
  keyword?: string;
  /**
   * Max evidence rows frozen from policy at create (non-secret; public).
   * Worker hard-fails if this cap would be exceeded.
   */
  maxExportRows?: number;
  /** Policy revision frozen at create (non-secret; public). */
  policyRevision?: number;
  /** Title-only conversation search (never body). */
  q?: string;
  requestId?: string;
  result?: PlatformAuditResult;
  results?: PlatformAuditResult[];
  sessionId?: string;
  targetId?: string;
  targetType?: string;
  /** Exclusive upper bound ISO-8601 (frozen at create). */
  to?: string;
  topicId?: string;
  userId?: string;
  workspaceId?: string;
}

/** Typed retention progress / outcome counters. */
export interface PlatformAuditRetentionCounts {
  conversationsDeleted?: number;
  conversationsScanned?: number;
  exportArtifactsDeleted?: number;
  exportArtifactsScanned?: number;
  messagesDeleted?: number;
  messagesScanned?: number;
  operationLogsDeleted?: number;
  operationLogsScanned?: number;
  sessionsDeleted?: number;
  sessionsScanned?: number;
  /** Rows skipped because an active legal hold matched. */
  skippedLegalHold?: number;
  topicsDeleted?: number;
  topicsScanned?: number;
}

/**
 * Platform-wide audit policy singleton (CAS via `revision`).
 * One logical row (`id = global`); getOrCreate materializes defaults.
 *
 * Defaults: operation logs 365d, conversations 180d, export artifacts 7d,
 * max export rows 50_000, max list window 90d.
 */
export const platformAuditPolicies = pgTable(
  'platform_audit_policies',
  {
    /** Deterministic singleton id — always `global`. */
    id: text('id').primaryKey().notNull(),

    /** Optimistic concurrency token; updateCAS requires expectedRevision match. */
    revision: integer('revision').notNull().default(PLATFORM_AUDIT_POLICY_DEFAULTS.revision),

    operationLogRetentionDays: integer('operation_log_retention_days')
      .notNull()
      .default(PLATFORM_AUDIT_POLICY_DEFAULTS.operationLogRetentionDays),
    conversationRetentionDays: integer('conversation_retention_days')
      .notNull()
      .default(PLATFORM_AUDIT_POLICY_DEFAULTS.conversationRetentionDays),
    exportArtifactRetentionDays: integer('export_artifact_retention_days')
      .notNull()
      .default(PLATFORM_AUDIT_POLICY_DEFAULTS.exportArtifactRetentionDays),

    contentAccessMode: varchar('content_access_mode', { length: 32 })
      .$type<PlatformAuditContentAccessMode>()
      .notNull()
      .default(PLATFORM_AUDIT_POLICY_DEFAULTS.contentAccessMode),

    /** When false, export artifacts never include raw message bodies. */
    messageBodyInExport: boolean('message_body_in_export')
      .notNull()
      .default(PLATFORM_AUDIT_POLICY_DEFAULTS.messageBodyInExport),

    maxExportRows: integer('max_export_rows')
      .notNull()
      .default(PLATFORM_AUDIT_POLICY_DEFAULTS.maxExportRows),
    maxListWindowDays: integer('max_list_window_days')
      .notNull()
      .default(PLATFORM_AUDIT_POLICY_DEFAULTS.maxListWindowDays),

    redactionProfile: varchar('redaction_profile', { length: 32 })
      .$type<PlatformAuditRedactionProfile>()
      .notNull()
      .default(PLATFORM_AUDIT_POLICY_DEFAULTS.redactionProfile),

    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('platform_audit_policies_revision_check', sql`${t.revision} >= 0`),
    check(
      'platform_audit_policies_operation_log_retention_days_check',
      sql`${t.operationLogRetentionDays} >= 1 AND ${t.operationLogRetentionDays} <= 3650`,
    ),
    check(
      'platform_audit_policies_conversation_retention_days_check',
      sql`${t.conversationRetentionDays} >= 1 AND ${t.conversationRetentionDays} <= 3650`,
    ),
    check(
      'platform_audit_policies_export_artifact_retention_days_check',
      sql`${t.exportArtifactRetentionDays} >= 1 AND ${t.exportArtifactRetentionDays} <= 365`,
    ),
    check(
      'platform_audit_policies_max_export_rows_check',
      sql`${t.maxExportRows} >= 1 AND ${t.maxExportRows} <= 1000000`,
    ),
    check(
      'platform_audit_policies_max_list_window_days_check',
      sql`${t.maxListWindowDays} >= 1 AND ${t.maxListWindowDays} <= 365`,
    ),
    check(
      'platform_audit_policies_content_access_mode_check',
      sql`${t.contentAccessMode} IN ('disabled', 'metadata_only', 'content_allowed')`,
    ),
    check(
      'platform_audit_policies_redaction_profile_check',
      sql`${t.redactionProfile} IN ('strict', 'standard')`,
    ),
  ],
);

export type PlatformAuditPolicyItem = typeof platformAuditPolicies.$inferSelect;
export type NewPlatformAuditPolicy = typeof platformAuditPolicies.$inferInsert;

/**
 * Admin audit export jobs: filter snapshot + async status + private artifact storage key.
 * `jobId` optionally links to `platform_jobs` without a hard FK (lifecycle-independent).
 * Never persist signed download URLs — only private `storageKey`.
 */
export const platformAuditExports = pgTable(
  'platform_audit_exports',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformAuditExports', 16))
      .primaryKey()
      .notNull(),

    kind: varchar('kind', { length: 32 }).$type<PlatformAuditExportKind>().notNull(),

    status: varchar('status', { length: 32 })
      .$type<PlatformAuditExportStatus>()
      .notNull()
      .default('pending'),

    /** Immutable filter contract evaluated by the export worker. */
    filterSnapshot: jsonb('filter_snapshot')
      .$type<PlatformAuditExportFilterSnapshot>()
      .notNull()
      .default({}),

    /** Soft link to platform_jobs.id when a worker is scheduled (unique when set). */
    jobId: text('job_id'),

    /** Whether this export includes raw message bodies (policy snapshot at create). */
    includesMessageBodies: boolean('includes_message_bodies').notNull().default(false),

    /** Hex/base64 checksum of the completed artifact (content integrity). */
    artifactChecksum: text('artifact_checksum'),
    /** Private object storage key — never a signed URL. */
    storageKey: text('storage_key'),
    artifactBytes: bigint('artifact_bytes', { mode: 'number' }),
    rowCount: integer('row_count'),

    expiresAt: timestamptz('expires_at'),
    /**
     * Terminal failure payload, publication fencing, or durable artifact-purge outbox.
     * Purge is two-phase: `purgeStatus=pending` (claimed) → `deleting` (authorized under
     * hold lock; external delete runs outside the TX) → cleared after object destroy.
     * Publication fencing: `attemptToken` binds a running export to one worker attempt.
     */
    error: jsonb('error').$type<{
      /** Fencing token for the active publication attempt (running only). */
      attemptToken?: string;
      code?: string;
      message?: string;
      /**
       * Two-phase purge state. `deleting` means the external object destroy was
       * authorized and may already have happened — legal holds must not activate
       * against missing evidence until this row is reconciled.
       */
      purgeStatus?: 'pending' | 'deleting';
      /** Private storage key awaiting object-store purge (outbox; never a signed URL). */
      purgeStorageKey?: string;
      /** All attempt keys pending purge (append-on-record; prevents orphaned attempts). */
      purgeStorageKeys?: string[];
      /** Immutable token for the current purge authorization epoch. */
      purgeToken?: string;
    } | null>(),

    /** Actor who requested the export (required for accountability). */
    requestedBy: text('requested_by').notNull(),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('platform_audit_exports_status_created_at_idx').on(t.status, t.createdAt),
    index('platform_audit_exports_kind_created_at_idx').on(t.kind, t.createdAt),
    index('platform_audit_exports_requested_by_idx').on(t.requestedBy),
    index('platform_audit_exports_expires_at_idx').on(t.expiresAt),
    // Retention artifact candidates: coalesce(finished_at,created_at),id with storage present (DB-006).
    index('platform_audit_exports_retention_sort_at_id_idx')
      .using('btree', sql`coalesce(${t.finishedAt}, ${t.createdAt})`, t.id)
      .where(sql`${t.storageKey} IS NOT NULL AND ${t.status} IN ('completed','expired')`),
    // Purge outbox recovery: terminal rows with storage_key null + purge key(s) (DB-006).
    // Predicate must imply listPendingArtifactPurges: single key OR purgeStorageKeys array.
    index('platform_audit_exports_purge_outbox_updated_at_id_idx')
      .on(t.updatedAt, t.id)
      .where(
        sql`${t.storageKey} IS NULL AND ${t.status} IN ('expired','failed','cancelled') AND (coalesce(${t.error}->>'purgeStorageKey','') <> '' OR jsonb_typeof(${t.error}->'purgeStorageKeys') = 'array')`,
      ),
    // w1-evidence: hot-path scan for legal-hold create (purgeStatus=deleting).
    index('platform_audit_exports_purge_status_deleting_idx')
      .on(t.id)
      .where(sql`coalesce(${t.error}->>'purgeStatus', '') = 'deleting'`),
    // w1-evidence: expression predicate aligned with listPending / complete delete
    // (single key OR non-empty purgeStorageKeys array — w1 owns this predicate).
    index('platform_audit_exports_purge_storage_key_expr_idx')
      .using('btree', sql`coalesce(${t.error}->>'purgeStorageKey', '')`)
      .where(
        sql`coalesce(${t.error}->>'purgeStorageKey', '') <> '' OR (jsonb_typeof(${t.error}->'purgeStorageKeys') = 'array' AND jsonb_array_length(${t.error}->'purgeStorageKeys') > 0)`,
      ),
    // Idempotency: at most one export row per platform job when linked.
    uniqueIndex('platform_audit_exports_job_id_unique')
      .on(t.jobId)
      .where(sql`${t.jobId} IS NOT NULL`),
    check(
      'platform_audit_exports_kind_check',
      sql`${t.kind} IN ('operation_logs', 'conversations', 'user_timeline')`,
    ),
    check(
      'platform_audit_exports_status_check',
      sql`${t.status} IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'expired')`,
    ),
    check(
      'platform_audit_exports_row_count_check',
      sql`${t.rowCount} IS NULL OR ${t.rowCount} >= 0`,
    ),
    check(
      'platform_audit_exports_artifact_bytes_check',
      sql`${t.artifactBytes} IS NULL OR ${t.artifactBytes} >= 0`,
    ),
    // Completed exports must carry private storage key, checksum, and expiry.
    check(
      'platform_audit_exports_completed_artifact_check',
      sql`${t.status} <> 'completed' OR (
        ${t.storageKey} IS NOT NULL
        AND ${t.artifactChecksum} IS NOT NULL
        AND ${t.expiresAt} IS NOT NULL
      )`,
    ),
  ],
);

export type PlatformAuditExportItem = typeof platformAuditExports.$inferSelect;
export type NewPlatformAuditExport = typeof platformAuditExports.$inferInsert;

/**
 * Retention dry-run / execute runs with single typed scope, cutoff, and progress counts.
 */
export const platformAuditRetentionRuns = pgTable(
  'platform_audit_retention_runs',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformAuditRetentionRuns', 16))
      .primaryKey()
      .notNull(),

    mode: varchar('mode', { length: 16 }).$type<PlatformAuditRetentionMode>().notNull(),

    scope: varchar('scope', { length: 32 }).$type<PlatformAuditRetentionScope>().notNull(),

    /** Rows older than this instant are candidates (policy-derived at create). */
    cutoffAt: timestamptz('cutoff_at').notNull(),

    /** Policy revision snapshot at create time (auditability of which policy produced cutoff). */
    policyRevision: integer('policy_revision').notNull(),

    status: varchar('status', { length: 32 })
      .$type<PlatformAuditRetentionRunStatus>()
      .notNull()
      .default('pending'),

    counts: jsonb('counts').$type<PlatformAuditRetentionCounts>().notNull().default({}),

    progressDone: integer('progress_done').notNull().default(0),
    progressTotal: integer('progress_total'),

    /** Soft link to platform_jobs.id when a worker is scheduled (unique when set). */
    jobId: text('job_id'),

    error: jsonb('error').$type<{ code?: string; message?: string } | null>(),
    /** Actor who requested the retention run (required for accountability). */
    requestedBy: text('requested_by').notNull(),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('platform_audit_retention_runs_status_created_at_idx').on(t.status, t.createdAt),
    index('platform_audit_retention_runs_scope_created_at_idx').on(t.scope, t.createdAt),
    index('platform_audit_retention_runs_requested_by_idx').on(t.requestedBy),
    uniqueIndex('platform_audit_retention_runs_job_id_unique')
      .on(t.jobId)
      .where(sql`${t.jobId} IS NOT NULL`),
    check('platform_audit_retention_runs_mode_check', sql`${t.mode} IN ('dry_run', 'execute')`),
    check(
      'platform_audit_retention_runs_scope_check',
      sql`${t.scope} IN ('operation_logs', 'conversations', 'export_artifacts')`,
    ),
    check(
      'platform_audit_retention_runs_status_check',
      sql`${t.status} IN ('pending', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    check('platform_audit_retention_runs_policy_revision_check', sql`${t.policyRevision} >= 0`),
    check('platform_audit_retention_runs_progress_done_check', sql`${t.progressDone} >= 0`),
    check(
      'platform_audit_retention_runs_progress_total_check',
      sql`${t.progressTotal} IS NULL OR ${t.progressTotal} >= 0`,
    ),
  ],
);

export type PlatformAuditRetentionRunItem = typeof platformAuditRetentionRuns.$inferSelect;
export type NewPlatformAuditRetentionRun = typeof platformAuditRetentionRuns.$inferInsert;

/**
 * Legal holds freeze retention / destructive audit cleanup for a scope.
 * Global holds store `scopeId = NULL` (never the `*` sentinel).
 */
export const platformAuditLegalHolds = pgTable(
  'platform_audit_legal_holds',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformAuditLegalHolds', 16))
      .primaryKey()
      .notNull(),

    scopeType: varchar('scope_type', { length: 32 })
      .$type<PlatformAuditLegalHoldScopeType>()
      .notNull(),

    /**
     * Target id for user/session/topic/workspace.
     * Global holds MUST store NULL (enforced by check + partial unique indexes).
     */
    scopeId: text('scope_id'),

    status: varchar('status', { length: 16 })
      .$type<PlatformAuditLegalHoldStatus>()
      .notNull()
      .default('active'),

    reason: text('reason').notNull(),
    /** Actor who created the hold (required for accountability). */
    createdBy: text('created_by').notNull(),
    releasedBy: text('released_by'),
    releaseReason: text('release_reason'),
    releasedAt: timestamptz('released_at'),

    /** Optional auto-expiry; findActiveScopes ignores holds past this instant. */
    expiresAt: timestamptz('expires_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('platform_audit_legal_holds_status_scope_idx').on(t.status, t.scopeType, t.scopeId),
    index('platform_audit_legal_holds_scope_idx').on(t.scopeType, t.scopeId),
    index('platform_audit_legal_holds_created_by_idx').on(t.createdBy),
    index('platform_audit_legal_holds_expires_at_idx').on(t.expiresAt),
    // At most one active global hold (scopeId is always NULL for global).
    uniqueIndex('platform_audit_legal_holds_active_global_unique')
      .on(t.scopeType)
      .where(sql`${t.status} = 'active' AND ${t.scopeType} = 'global'`),
    // At most one active hold per (scopeType, scopeId) for non-global scopes.
    uniqueIndex('platform_audit_legal_holds_active_scope_unique')
      .on(t.scopeType, t.scopeId)
      .where(sql`${t.status} = 'active' AND ${t.scopeType} <> 'global'`),
    check(
      'platform_audit_legal_holds_scope_type_check',
      sql`${t.scopeType} IN ('user', 'session', 'topic', 'workspace', 'global')`,
    ),
    check('platform_audit_legal_holds_status_check', sql`${t.status} IN ('active', 'released')`),
    // Global holds: scopeId MUST be NULL. Non-global: scopeId MUST be present.
    check(
      'platform_audit_legal_holds_scope_id_shape_check',
      sql`(${t.scopeType} = 'global' AND ${t.scopeId} IS NULL)
        OR (${t.scopeType} <> 'global' AND ${t.scopeId} IS NOT NULL)`,
    ),
    // Released holds require releasedBy + non-empty releaseReason + releasedAt.
    check(
      'platform_audit_legal_holds_release_shape_check',
      sql`${t.status} <> 'released' OR (
        ${t.releasedBy} IS NOT NULL
        AND ${t.releaseReason} IS NOT NULL
        AND btrim(${t.releaseReason}) <> ''
        AND ${t.releasedAt} IS NOT NULL
      )`,
    ),
  ],
);

export type PlatformAuditLegalHoldItem = typeof platformAuditLegalHolds.$inferSelect;
export type NewPlatformAuditLegalHold = typeof platformAuditLegalHolds.$inferInsert;
