/**
 * Map stored / internal job errors onto the strict public DTO:
 * `{ code }` only — never raw messages, Error.name, or purge outbox fields.
 *
 * Contracts (`adminAuditJobErrorSchema`) are intentionally code-only for security.
 * Domain rows may still keep internal `message` / `purgeStorageKey` for recovery.
 */

/** Mirrors adminAuditJobErrorCodeSchema — keep in sync with contracts/adminAudit/common. */
export const ADMIN_AUDIT_JOB_ERROR_CODES = [
  'ARTIFACT_TOO_LARGE',
  'CONTENT_ACCESS_DISABLED',
  'EXPORT_FAILED',
  'EXPORT_TERMINAL',
  'INTERNAL_ERROR',
  'INVALID_FILTER_SNAPSHOT',
  'INVALID_INPUT',
  'MAX_EXPORT_ROWS_EXCEEDED',
  'NOT_FOUND',
  'RETENTION_FAILED',
  'RUN_TERMINAL',
] as const;

export type AdminAuditJobErrorCode = (typeof ADMIN_AUDIT_JOB_ERROR_CODES)[number];

const CODE_SET = new Set<string>(ADMIN_AUDIT_JOB_ERROR_CODES);

/** Internal purge markers — never public job error codes. */
const INTERNAL_PURGE_CODES = new Set(['ARTIFACT_PURGE_PENDING', 'ARTIFACT_PURGE_DEFERRED_HOLD']);

export type StoredJobError = {
  code?: string;
  message?: string;
  purgeStorageKey?: string;
} | null;

/**
 * Project a stored export/retention error to the public code-only shape.
 * Returns null when there is no stable public code (e.g. purge-only outbox).
 */
export const toPublicJobError = (
  error: StoredJobError | undefined,
  fallback: AdminAuditJobErrorCode = 'INTERNAL_ERROR',
): { code: AdminAuditJobErrorCode } | null => {
  if (!error?.code) return null;
  if (INTERNAL_PURGE_CODES.has(error.code)) return null;
  if (CODE_SET.has(error.code)) {
    return { code: error.code as AdminAuditJobErrorCode };
  }
  return { code: fallback };
};

/**
 * Map an unknown thrown value onto a bounded public/export error code.
 * Never forwards Error.name or free-form strings as codes.
 */
export const mapExportFailureCode = (error: unknown): AdminAuditJobErrorCode => {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = String((error as { name?: string }).name);
    switch (name) {
      case 'AuditExportMaxRowsError': {
        return 'MAX_EXPORT_ROWS_EXCEEDED';
      }
      case 'AuditExportInvalidFilterError': {
        return 'INVALID_FILTER_SNAPSHOT';
      }
      case 'AuditExportArtifactTooLargeError': {
        return 'ARTIFACT_TOO_LARGE';
      }
      default: {
        break;
      }
    }
  }
  return 'EXPORT_FAILED';
};

export const mapRetentionFailureCode = (error: unknown): AdminAuditJobErrorCode => {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = String((error as { name?: string }).name);
    if (name === 'AuditRetentionInvalidDataError') return 'INVALID_INPUT';
  }
  return 'RETENTION_FAILED';
};
