/**
 * Deterministic object-key builders for admin audit export artifacts.
 */

export const AUDIT_EXPORT_STORAGE_KEY_PREFIX = 'platform-audit-exports';
export const AUDIT_EXPORT_ARTIFACT_FILENAME = 'evidence.ndjson';
export const AUDIT_EXPORT_CONTENT_TYPE = 'application/x-ndjson';

/** Deterministic private object key (legacy; attempt-unique keys are preferred). */
export const buildAuditExportStorageKey = (exportId: string): string =>
  `${AUDIT_EXPORT_STORAGE_KEY_PREFIX}/${exportId}/${AUDIT_EXPORT_ARTIFACT_FILENAME}`;

/**
 * Prefix under which all attempt-unique publication keys for an export live.
 * Dead-letter reconcile / multi-attempt purge use this when individual keys are
 * unknown — never the legacy deterministic filename (no attempt writes there).
 */
export const buildAuditExportAttemptsPrefix = (exportId: string): string =>
  `${AUDIT_EXPORT_STORAGE_KEY_PREFIX}/${exportId}/attempts/`;

/** True when a purge outbox entry is the attempts/ prefix (not a single object key). */
export const isAuditExportAttemptsPrefix = (storageKey: string): boolean =>
  storageKey.endsWith('/attempts/') || /\/attempts\/$/u.test(storageKey);

/**
 * Attempt-unique object key for fenced publication (SAO-002).
 * Each worker attempt uploads to its own key; only the fenced `complete()` winner
 * publishes that key onto the domain row. Losers delete only their own attempt key.
 */
export const buildAuditExportAttemptStorageKey = (
  exportId: string,
  attemptToken: string,
): string => {
  // Sanitize token for S3 key safety (jobId:attempt → jobId_attempt).
  const safe = attemptToken.replaceAll(/[^\w.-]+/g, '_').slice(0, 128);
  return `${AUDIT_EXPORT_STORAGE_KEY_PREFIX}/${exportId}/attempts/${safe}/${AUDIT_EXPORT_ARTIFACT_FILENAME}`;
};

/** Build a fencing token from platform_jobs claim identity. */
export const buildAuditExportAttemptToken = (jobId: string, attempt: number): string =>
  `${jobId}:${attempt}`;
