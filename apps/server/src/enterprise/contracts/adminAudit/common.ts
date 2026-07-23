/**
 * Strict Zod contracts for `admin.audit.*` (A2 + A3 exports/retention).
 *
 * Data contract:
 * - Operation event detail returns stored before/after diffs (write-time redaction only).
 * - Conversation/message body is full and unlimited when content_allowed + permission;
 *   only credentials are masked — no PII/business-text redaction or length truncation.
 * - Export artifacts store operation diffs exactly; conversation bodies only when allowed,
 *   with credential-only masking (no generic redaction / summarization / body truncation).
 * - Lists may omit large detail fields; detail preserves full non-credential evidence.
 * - Access-log filter summaries never include free-text `q`, message bodies, or download URLs.
 * - Export list/get never expose storageKey; only download returns a short-lived signed URL.
 * - Retention runs persist single scopes only; API scope `all` fans out into three rows.
 */

import { z } from 'zod';

import { SECRET_SAFE_TEXT_MAX, secretSafeAuditReasonSchema, strictDateSchema } from '../shared';

export const ADMIN_AUDIT_LIST_DEFAULT_LIMIT = 50;
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
export const platformAuditRedactionProfileSchema = z.enum(['strict', 'standard']);
export const platformAuditLegalHoldScopeTypeSchema = z.enum([
  'user',
  'session',
  'topic',
  'workspace',
  'global',
]);
export const platformAuditLegalHoldStatusSchema = z.enum(['active', 'released']);
