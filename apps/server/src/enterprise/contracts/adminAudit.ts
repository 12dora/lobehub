/**
 * Strict Zod contracts for `admin.audit.*` (A2 + A3 exports/retention).
 *
 * Implementation is split by subdomain under `./adminAudit/`; this file is the stable
 * public barrel so existing `.../contracts/adminAudit` import paths remain valid.
 *
 * Data contract:
 * - Operation event detail returns stored before/after diffs (write-time redaction only).
 * - Conversation/message body is full and unlimited when content_allowed + permission.
 *   Credentials are masked unless live-view `redactionProfile` is `'off'` (fail-closed:
 *   missing/unknown still mask). No PII/business-text redaction or length truncation.
 *   Conversation list/get/messages and user-timeline envelopes expose the active profile
 *   so clients can drop cached raw evidence when it tightens.
 * - Export artifacts store operation diffs exactly; conversation bodies only when allowed,
 *   with credential-only masking (no generic redaction / summarization / body truncation).
 * - Lists may omit large detail fields; detail preserves full non-credential evidence.
 * - Access-log filter summaries never include free-text `q`, message bodies, or download URLs.
 * - Export list/get never expose storageKey; only download returns a short-lived signed URL.
 * - Retention runs persist single scopes only; API scope `all` fans out into three rows.
 */

export {
  type AdminAuditAccessFilterSummary,
  adminAuditAccessFilterSummarySchema,
} from './adminAudit/accessFilter';
export {
  ADMIN_AUDIT_FACET_DEFAULT_LIMIT,
  ADMIN_AUDIT_FACET_MAX_LIMIT,
  ADMIN_AUDIT_LIST_DEFAULT_LIMIT,
  ADMIN_AUDIT_LIST_MAX_LIMIT,
  ADMIN_AUDIT_Q_MAX_LENGTH,
  ADMIN_AUDIT_REASON_MAX_LENGTH,
  adminAuditCursorSchema,
  adminAuditJobErrorCodeSchema,
  adminAuditJobErrorSchema,
  dateInputSchema,
  platformAuditContentAccessModeSchema,
  platformAuditLegalHoldScopeTypeSchema,
  platformAuditLegalHoldStatusSchema,
  platformAuditRedactionProfileSchema,
  platformAuditResultSchema,
  /** Central admin user-id bound (min 1 / max 128) — reused outside audit too. */
  userIdSchema,
} from './adminAudit/common';
export {
  adminAuditConversationListItemSchema,
  adminAuditConversationMessageListItemSchema,
  adminAuditConversationsGetInputSchema,
  adminAuditConversationsGetOutputSchema,
  type AdminAuditConversationsListInputParsed,
  adminAuditConversationsListInputSchema,
  adminAuditConversationsListOutputSchema,
  type AdminAuditConversationsMessagesInputParsed,
  adminAuditConversationsMessagesInputSchema,
  adminAuditConversationsMessagesOutputSchema,
} from './adminAudit/conversations';
export {
  adminAuditEventDetailSchema,
  adminAuditEventListItemSchema,
  type AdminAuditEventsFacetsInputParsed,
  adminAuditEventsFacetsInputSchema,
  adminAuditEventsFacetsOutputSchema,
  adminAuditEventsGetInputSchema,
  adminAuditEventsGetOutputSchema,
  type AdminAuditEventsListInput,
  type AdminAuditEventsListInputParsed,
  adminAuditEventsListInputSchema,
  adminAuditEventsListOutputSchema,
  adminAuditEventsStatsInputSchema,
  adminAuditEventsStatsOutputSchema,
} from './adminAudit/events';
export {
  ADMIN_AUDIT_EXPORT_DOWNLOAD_URL_TTL_SECONDS,
  adminAuditExportItemSchema,
  type AdminAuditExportsCancelInput,
  adminAuditExportsCancelInputSchema,
  adminAuditExportsCancelOutputSchema,
  type AdminAuditExportsCreateInput,
  type AdminAuditExportsCreateInputParsed,
  adminAuditExportsCreateInputSchema,
  adminAuditExportsCreateOutputSchema,
  type AdminAuditExportsDownloadInput,
  adminAuditExportsDownloadInputSchema,
  adminAuditExportsDownloadOutputSchema,
  adminAuditExportsGetInputSchema,
  adminAuditExportsGetOutputSchema,
  type AdminAuditExportsListInputParsed,
  adminAuditExportsListInputSchema,
  adminAuditExportsListOutputSchema,
  platformAuditExportKindSchema,
  platformAuditExportStatusSchema,
} from './adminAudit/exports';
export {
  adminAuditLegalHoldItemSchema,
  type AdminAuditLegalHoldsCreateInput,
  type AdminAuditLegalHoldsCreateInputParsed,
  adminAuditLegalHoldsCreateInputSchema,
  adminAuditLegalHoldsCreateOutputSchema,
  adminAuditLegalHoldsGetInputSchema,
  adminAuditLegalHoldsGetOutputSchema,
  type AdminAuditLegalHoldsListInputParsed,
  adminAuditLegalHoldsListInputSchema,
  adminAuditLegalHoldsListOutputSchema,
  type AdminAuditLegalHoldsReleaseInput,
  adminAuditLegalHoldsReleaseInputSchema,
  adminAuditLegalHoldsReleaseOutputSchema,
} from './adminAudit/legalHolds';
export {
  adminAuditPolicyGetOutputSchema,
  type AdminAuditPolicyUpdateInput,
  adminAuditPolicyUpdateInputSchema,
  adminAuditPolicyUpdateOutputSchema,
} from './adminAudit/policy';
export {
  type AdminAuditRetentionCancelInput,
  adminAuditRetentionCancelInputSchema,
  adminAuditRetentionCancelOutputSchema,
  adminAuditRetentionCountsSchema,
  type AdminAuditRetentionCreateInput,
  adminAuditRetentionCreateInputSchema,
  adminAuditRetentionCreateOutputSchema,
  adminAuditRetentionGetRunInputSchema,
  adminAuditRetentionGetRunOutputSchema,
  type AdminAuditRetentionListRunsInputParsed,
  adminAuditRetentionListRunsInputSchema,
  adminAuditRetentionListRunsOutputSchema,
  adminAuditRetentionRunItemSchema,
  adminAuditRetentionStatusInputSchema,
  adminAuditRetentionStatusOutputSchema,
  platformAuditRetentionApiScopeSchema,
  platformAuditRetentionModeSchema,
  platformAuditRetentionRunStatusSchema,
  platformAuditRetentionScopeSchema,
} from './adminAudit/retention';
export {
  adminAuditUserSearchItemSchema,
  type AdminAuditUsersSearchInputParsed,
  adminAuditUsersSearchInputSchema,
  adminAuditUsersSearchOutputSchema,
  adminAuditUsersSummaryInputSchema,
  adminAuditUsersSummaryOutputSchema,
  type AdminAuditUsersTimelineInputParsed,
  adminAuditUsersTimelineInputSchema,
  adminAuditUsersTimelineItemSchema,
  adminAuditUsersTimelineOutputSchema,
} from './adminAudit/users';
