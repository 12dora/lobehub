/** platform_jobs.type for admin audit retention workers (dry_run + execute). */
export const PLATFORM_AUDIT_RETENTION_JOB_TYPE = 'platform.audit.retention.v1';

export const AUDIT_RETENTION_BATCH_LIMIT = 50;
export const AUDIT_RETENTION_DEFAULT_LEASE_MS = 60_000;
export const AUDIT_RETENTION_MAX_ATTEMPTS = 3;

/** Stored scopes only — `all` is a service-layer fan-out. */
export const AUDIT_RETENTION_STORED_SCOPES = [
  'operation_logs',
  'conversations',
  'export_artifacts',
] as const;

export type AuditRetentionJobInput = {
  runId: string;
};

export type AuditRetentionJobCursor = {
  /** Keyset cursor string for the active scope scan. */
  keyset?: string | null;
  /** Version for forward-compatible cursor shapes. */
  v: 1;
};

export const buildAuditRetentionJobIdempotencyKey = (runId: string): string =>
  `audit-retention:${runId}`;

export const parseAuditRetentionJobInput = (
  input: Record<string, unknown> | null | undefined,
): AuditRetentionJobInput | null => {
  if (!input || typeof input.runId !== 'string' || input.runId.length === 0) {
    return null;
  }
  return { runId: input.runId };
};

export const parseAuditRetentionJobCursor = (cursor: unknown): AuditRetentionJobCursor | null => {
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
  const c = cursor as Record<string, unknown>;
  if (c.v !== 1) return null;
  const keyset =
    c.keyset === null || c.keyset === undefined
      ? null
      : typeof c.keyset === 'string'
        ? c.keyset
        : null;
  if (c.keyset !== undefined && c.keyset !== null && typeof c.keyset !== 'string') {
    return null;
  }
  return { keyset, v: 1 };
};
