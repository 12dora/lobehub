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

export const parseAuditExportJobInput = (
  input: Record<string, unknown> | null | undefined,
): AuditExportJobInput | null => {
  if (!input || typeof input.exportId !== 'string' || input.exportId.length === 0) {
    return null;
  }
  return { exportId: input.exportId };
};
