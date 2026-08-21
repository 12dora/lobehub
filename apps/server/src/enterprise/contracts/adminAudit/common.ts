/**
 * Strict Zod contracts for `admin.audit.*` (A2 + A3 exports/retention).
 *
 * Data contract:
 * - Operation event detail and exports recursively remove fingerprint-named fields at read time
 *   while preserving all other non-credential evidence in stored before/after diffs.
 * - Conversation/message body is full and unlimited when content_allowed + permission.
 *   Credentials are masked unless `redactionProfile` is `'off'` (fail-closed: missing/unknown
 *   still mask). No PII/business-text redaction or length truncation.
 * - Export artifacts preserve non-fingerprint operation evidence; conversation bodies are
 *   included only when allowed, with credential-only masking always (even when live-view
 *   `redactionProfile` is `'off'`) and no generic summarization or length truncation.
 * - Lists may omit large detail fields; detail preserves full non-credential evidence.
 * - Access-log filter summaries never include free-text `q`, message bodies, or download URLs.
 * - Export list/get never expose storageKey; only download returns a short-lived signed URL.
 * - Retention runs persist single scopes only; API scope `all` fans out into three rows.
 */

import { z } from 'zod';

import { SECRET_SAFE_TEXT_MAX, secretSafeAuditReasonSchema, strictDateSchema } from '../shared';

/** Mirrors the admin UI's shared DEFAULT_PAGE_SIZE so an omitted limit matches the table. */
export const ADMIN_AUDIT_LIST_DEFAULT_LIMIT = 25;
export const ADMIN_AUDIT_LIST_MAX_LIMIT = 200;
export const ADMIN_AUDIT_FACET_DEFAULT_LIMIT = 20;
export const ADMIN_AUDIT_FACET_MAX_LIMIT = 50;
export const ADMIN_AUDIT_Q_MAX_LENGTH = 200;
export const ADMIN_AUDIT_REASON_MAX_LENGTH = SECRET_SAFE_TEXT_MAX;

/** Opaque keyset cursor: `${createdAt.toISOString()}|${id}`. */
export const adminAuditCursorSchema = z.string().min(1).max(128);

export const auditReasonSchema = secretSafeAuditReasonSchema;

/** Bounded date — real `Date` instances only (SuperJSON); reject coerce traps. */
export const dateInputSchema = strictDateSchema;

export const limitSchema = z.number().int().min(1).max(ADMIN_AUDIT_LIST_MAX_LIMIT).optional();

/** Title-only search string (conversations). Never full-text body search. */
export const titleQuerySchema = z.string().trim().min(1).max(ADMIN_AUDIT_Q_MAX_LENGTH).optional();

export const userIdSchema = z.string().min(1).max(128);
export const topicIdSchema = z.string().min(1).max(128);
export const idSchema = z.string().min(1).max(128);

export const platformAuditResultSchema = z.enum(['success', 'failure', 'denied']);
export const platformAuditContentAccessModeSchema = z.enum([
  'disabled',
  'metadata_only',
  'content_allowed',
]);
export const platformAuditRedactionProfileSchema = z.enum(['strict', 'standard', 'off']);
export const platformAuditLegalHoldScopeTypeSchema = z.enum([
  'user',
  'session',
  'topic',
  'workspace',
  'global',
]);
/** Stored DB values only. */
export const platformAuditLegalHoldStoredStatusSchema = z.enum(['active', 'released']);
/**
 * Public projection may surface `expired` when status is still stored as
 * `active` but `expiresAt` has elapsed (retention already ignores these).
 */
export const platformAuditLegalHoldStatusSchema = z.enum(['active', 'released', 'expired']);

/**
 * Stable public error codes for audit export / retention job projections.
 * Free-form Error.name / Error.message must never reach the DTO.
 */
export const adminAuditJobErrorCodeSchema = z.enum([
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
]);

/** Public job error — code only; no raw exception message. */
export const adminAuditJobErrorSchema = z
  .object({
    code: adminAuditJobErrorCodeSchema,
  })
  .strict();
