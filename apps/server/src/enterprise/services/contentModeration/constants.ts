/**
 * Audit action / target tokens for content moderation.
 *
 * B3 registers these in `auditActionCatalog.ts` + locale labels. Recorders write
 * the raw strings via `PlatformAuditLogModel.append` until that lands.
 */
export const CONTENT_MODERATION_AUDIT_ACTIONS = {
  CACHE_CLEAR: 'content_moderation.cache.clear',
  CLASSIFIER_TEST: 'content_moderation.classifier.test',
  RECORD_REVEAL: 'content_moderation.record.reveal',
  RECORDS_DELETE: 'content_moderation.records.delete',
  SETTINGS_UPDATE: 'content_moderation.settings.update',
  USER_AUTO_BAN: 'content_moderation.user.auto_ban',
} as const;

export type ContentModerationAuditAction =
  (typeof CONTENT_MODERATION_AUDIT_ACTIONS)[keyof typeof CONTENT_MODERATION_AUDIT_ACTIONS];

export const CONTENT_MODERATION_AUDIT_TARGET_TYPES = {
  RECORD: 'content_moderation_record',
  SETTINGS: 'content_moderation_settings',
} as const;

export type ContentModerationAuditTargetType =
  (typeof CONTENT_MODERATION_AUDIT_TARGET_TYPES)[keyof typeof CONTENT_MODERATION_AUDIT_TARGET_TYPES];

export const MODERATION_SNAPSHOT_CACHE_TTL_MS = 30_000;
export const MODERATION_SNAPSHOT_CACHE_SCOPE = 'content-moderation';
export const MODERATION_SNAPSHOT_CACHE_NAMESPACE = 'content-moderation-settings';
export const MODERATION_USER_ROLE_MEMO_TTL_MS = 30_000;
export const MODERATION_DEDUPE_WINDOW_MS = 60_000;
export const MODERATION_DEDUPE_MAX_ENTRIES = 5000;
export const MODERATION_NOTIFY_THROTTLE_MS = 60 * 60 * 1000;
export const MODERATION_PURGE_INTERVAL_MS = 60 * 60 * 1000;
export const MODERATION_KEY_FREEZE_MS = {
  AUTH: 10 * 60 * 1000,
  RATE_LIMIT: 60 * 1000,
  SERVER: 10_000,
} as const;
export const MODERATION_RETRY_BACKOFF_MS = [100, 200, 300] as const;
export const KEYWORD_REGEX_CHUNK_SIZE = 500;
export const AUTO_BAN_REASON_PREFIX = '内容审计：窗口内违规';
