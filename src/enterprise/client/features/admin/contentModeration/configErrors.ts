import type { TFunction } from 'i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

/**
 * `PLATFORM_CONFIG_VALIDATION_FAILED` carries `details.field` (and often `details.reason`).
 * Mapping the field path back to the control that caused it is the difference between
 * "保存失败" and "端点已更改，已保存的密钥需要重新输入".
 */
const FIELD_MESSAGE_KEY: Record<string, string> = {
  'keywords': 'contentModeration.errors.field.keywords',
  'classifier.llmJudge': 'contentModeration.errors.field.llmJudge',
  'classifier.moderationsApi.apiKeys': 'contentModeration.errors.field.apiKeys',
  'classifier.moderationsApi.apiKeys.keep': 'contentModeration.errors.field.apiKeysKeep',
  'classifier.moderationsApi.baseUrl': 'contentModeration.errors.field.baseUrl',
  'downgrade': 'contentModeration.errors.field.downgrade',
  'timezone': 'contentModeration.errors.field.timezone',
  'to': 'contentModeration.errors.field.range',
};

/** Reasons whose copy is more precise than the field-level default. */
const REASON_MESSAGE_KEY: Record<string, string> = {
  api_key_fingerprint_not_found: 'contentModeration.errors.reason.apiKeyMissing',
  regex_slow: 'contentModeration.errors.reason.regexSlow',
  regex_unsafe: 'contentModeration.errors.reason.regexUnsafe',
  too_many_regex_changes: 'contentModeration.errors.reason.tooManyRegexChanges',
  endpoint_changed_reenter_keys: 'contentModeration.errors.reason.endpointChanged',
  model_not_published: 'contentModeration.errors.reason.modelNotPublished',
  range_inverted: 'contentModeration.errors.reason.rangeInverted',
  range_too_long: 'contentModeration.errors.reason.rangeTooLong',
  too_many_api_keys: 'contentModeration.errors.reason.tooManyApiKeys',
  unknown_timezone: 'contentModeration.errors.reason.unknownTimezone',
};

export interface ConfigValidationMessage {
  /** Dotted config path the server rejected, when it named one. */
  field?: string;
  message: string;
  /**
   * Zero-based keyword-rule index the server pointed at, when the rejection is row-scoped.
   * The keyword table uses it to highlight the offending row and page to it.
   */
  ruleIndex?: number;
}

/** Row-scoped rejections carry an index into `config.keywords`. */
const ROW_SCOPED_REASONS = new Set(['regex_slow', 'regex_unsafe']);

/**
 * Resolve a server rejection into copy that names the offending field.
 * Returns `null` when the failure is not a config-validation error, so the caller keeps its
 * own generic message (a save can also fail for network / permission reasons).
 */
export const resolveConfigValidationMessage = (
  error: unknown,
  t: TFunction<'admin'>,
  fallbackKey: string,
): ConfigValidationMessage | null => {
  const mapped = mapEnterpriseError(error);
  if (mapped?.code !== 'PLATFORM_CONFIG_VALIDATION_FAILED') return null;

  const details = (mapped.details ?? {}) as Record<string, unknown>;
  const field = typeof details.field === 'string' ? details.field : undefined;
  const reason = typeof details.reason === 'string' ? details.reason : undefined;

  const key =
    (reason ? REASON_MESSAGE_KEY[reason] : undefined) ??
    (field ? FIELD_MESSAGE_KEY[field] : undefined) ??
    fallbackKey;

  const rawIndex = details.index;
  const index =
    typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0
      ? rawIndex
      : undefined;
  const ruleIndex =
    field === 'keywords' && reason && ROW_SCOPED_REASONS.has(reason) ? index : undefined;

  // Row-scoped copy is 1-based for humans; the index stays 0-based for the table.
  const message = t(key as never, ruleIndex === undefined ? undefined : { n: ruleIndex + 1 });

  return { field, message, ruleIndex };
};
