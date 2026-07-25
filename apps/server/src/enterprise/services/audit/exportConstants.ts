/** platform_jobs.type for admin audit export workers. */
export const PLATFORM_AUDIT_EXPORT_JOB_TYPE = 'platform.audit.export.v1';

export const AUDIT_EXPORT_BATCH_LIMIT = 100;
export const AUDIT_EXPORT_DEFAULT_LEASE_MS = 60_000;
export const AUDIT_EXPORT_ARTIFACT_VERSION = 1 as const;

export type AuditExportJobInput = {
  exportId: string;
};

export const buildAuditExportJobIdempotencyKey = (exportId: string): string =>
  `audit-export:${exportId}`;

/**
 * Client-owned mutation idempotency key for create/publish retries and concurrent
 * double-submit of the same logical export request. Scoped by actor so keys never
 * cross users. Distinct namespace from per-export keys (`audit-export:${exportId}`).
 */
export const buildAuditExportClientIdempotencyKey = (
  actorUserId: string,
  clientKey: string,
): string => `audit-export:client:${actorUserId}:${clientKey}`;

export const parseAuditExportJobInput = (
  input: Record<string, unknown> | null | undefined,
): AuditExportJobInput | null => {
  if (!input || typeof input.exportId !== 'string' || input.exportId.length === 0) {
    return null;
  }
  return { exportId: input.exportId };
};

/** Defense-in-depth ceiling on artifact bytes while streaming (F10). */
export const AUDIT_EXPORT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
