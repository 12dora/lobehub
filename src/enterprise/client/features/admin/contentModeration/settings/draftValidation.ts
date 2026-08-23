import { MODERATION_CATEGORIES, MODERATION_LIMITS } from '@/const/platform/contentModeration';
import type { KeywordRule } from '@/types/platform/contentModeration';

import { moderationEndpointChanged } from '../format';
import type { DraftIssue, ModerationSettingsDraft } from './draftTypes';

/**
 * Copy-length contracts the browser enforces up front.
 *
 * `blockMessage` matches the server schema (2,000). `downgradeMessage` is capped far lower
 * because it travels back on a RESPONSE HEADER (`MODERATION_HEADERS.MODEL`-adjacent override):
 * a 2,000-character CJK string is ~18 KB once percent-encoded, past what common proxies accept.
 */
export const MODERATION_BLOCK_MESSAGE_MAX = 2000;
export const MODERATION_DOWNGRADE_MESSAGE_MAX = 300;

/** Percent-encoded byte budget for the downgrade override that rides on a response header. */
export const MODERATION_DOWNGRADE_MESSAGE_MAX_ENCODED_BYTES = 2048;

/** Encoded size of the header value the runtime will emit for this message. */
export const encodedHeaderLength = (value: string): number => encodeURIComponent(value).length;

/**
 * API keys that will still exist AFTER the wire conversion.
 *
 * `toUpdateConfig` drops retained fingerprints once the endpoint moved, so validation has to
 * count the same set — otherwise an admin can acknowledge the endpoint warning, save, and end up
 * with a `moderations_api` classifier that has no key at all.
 */
export const effectiveApiKeyCount = (
  draft: ModerationSettingsDraft,
  persistedBaseUrl?: string,
): number => {
  const api = draft.config.classifier.moderationsApi;
  if (!api) return 0;
  const retained = moderationEndpointChanged(persistedBaseUrl, api.baseUrl)
    ? 0
    : api.apiKeys.length;
  return retained + draft.addedApiKeys.filter((key) => key.trim()).length;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;

/**
 * Compile results are memoized: validation re-runs over the whole rule list on every keyword
 * edit, and recompiling thousands of regexes per keystroke is the actual cost at the 10k ceiling.
 * The cache is bounded so a long editing session cannot grow it without limit.
 */
const REGEX_VALIDITY_CACHE_MAX = 20_000;
const regexValidityCache = new Map<string, boolean>();

/** Regex rules must compile the same way the server compiles them (`iu`). */
export const isValidKeywordRegex = (pattern: string): boolean => {
  const cached = regexValidityCache.get(pattern);
  if (cached !== undefined) return cached;
  let valid = true;
  try {
    new RegExp(pattern, 'iu');
  } catch {
    valid = false;
  }
  if (regexValidityCache.size >= REGEX_VALIDITY_CACHE_MAX) regexValidityCache.clear();
  regexValidityCache.set(pattern, valid);
  return valid;
};

/**
 * Keyword-rule validation, split out so callers can memoize it on the rule array identity —
 * at the 10,000-rule ceiling this is the only part of validation that is expensive.
 */
export const validateKeywordRules = (rules: readonly KeywordRule[]): DraftIssue[] => {
  const issues: DraftIssue[] = [];
  if (rules.length > MODERATION_LIMITS.KEYWORD_MAX_RULES) {
    issues.push({ key: 'keywordCount', params: { max: MODERATION_LIMITS.KEYWORD_MAX_RULES } });
  }
  rules.forEach((rule, index) => {
    if (!rule.pattern.trim()) issues.push({ key: 'keywordEmpty', params: { row: index + 1 } });
    else if (rule.pattern.length > MODERATION_LIMITS.KEYWORD_MAX_LENGTH) {
      issues.push({
        key: 'keywordTooLong',
        params: { max: MODERATION_LIMITS.KEYWORD_MAX_LENGTH, row: index + 1 },
      });
    } else if (rule.isRegex && !isValidKeywordRegex(rule.pattern)) {
      issues.push({ key: 'keywordRegex', params: { pattern: rule.pattern, row: index + 1 } });
    }
  });
  return issues;
};

export interface DraftBaseOptions {
  persistedBaseUrl?: string;
}

/** One rule per field group. Every rule reports only about the field it is named after. */
type DraftBaseRule = (draft: ModerationSettingsDraft, options: DraftBaseOptions) => DraftIssue[];

const requestKindsRule: DraftBaseRule = ({ config }) =>
  config.requestKinds.length === 0 ? [{ key: 'requestKindsRequired' }] : [];

const sampleRateRule: DraftBaseRule = ({ config }) =>
  config.scope.sampleRate < 0 || config.scope.sampleRate > 100 ? [{ key: 'sampleRateRange' }] : [];

const categoryThresholdRule: DraftBaseRule = ({ config }) => {
  const issues: DraftIssue[] = [];
  for (const category of MODERATION_CATEGORIES) {
    const policy = config.categories[category];
    if (!policy) continue;
    if (policy.threshold < 0 || policy.threshold > 1) {
      issues.push({ key: 'thresholdRange', params: { category } });
    }
  }
  return issues;
};

const llmJudgeRule: DraftBaseRule = ({ config }) => {
  if (config.classifier.kind !== 'llm_judge') return [];
  const judge = config.classifier.llmJudge;
  return !judge?.provider || !judge?.model ? [{ key: 'llmJudgeRequired' }] : [];
};

const moderationsApiRule: DraftBaseRule = (draft, options) => {
  const { config } = draft;
  if (config.classifier.kind !== 'moderations_api') return [];
  const api = config.classifier.moderationsApi;
  const issues: DraftIssue[] = [];
  if (!api?.baseUrl || !api?.model) issues.push({ key: 'moderationsApiRequired' });
  else if (!/^https?:\/\//.test(api.baseUrl)) issues.push({ key: 'moderationsApiUrl' });
  // Count the keys that survive the save, not the ones currently on screen.
  if (api && effectiveApiKeyCount(draft, options.persistedBaseUrl) === 0) {
    issues.push({ key: 'moderationsApiKeyRequired' });
  }
  return issues;
};

const downgradeTargetRule: DraftBaseRule = ({ config }) =>
  config.downgrade && (!config.downgrade.provider || !config.downgrade.model)
    ? [{ key: 'downgradeIncomplete' }]
    : [];

const blockMessageRule: DraftBaseRule = ({ config }) =>
  config.messages.blockMessage.length > MODERATION_BLOCK_MESSAGE_MAX
    ? [{ key: 'blockMessageTooLong', params: { max: MODERATION_BLOCK_MESSAGE_MAX } }]
    : [];

const downgradeMessageRule: DraftBaseRule = ({ config }) => {
  const message = config.messages.downgradeMessage;
  if (message.length > MODERATION_DOWNGRADE_MESSAGE_MAX) {
    return [{ key: 'downgradeMessageTooLong', params: { max: MODERATION_DOWNGRADE_MESSAGE_MAX } }];
  }
  if (encodedHeaderLength(message) > MODERATION_DOWNGRADE_MESSAGE_MAX_ENCODED_BYTES) {
    // Within the character cap but still too heavy once percent-encoded (CJK is 9 bytes/char).
    return [
      {
        key: 'downgradeMessageTooHeavy',
        params: { max: MODERATION_DOWNGRADE_MESSAGE_MAX_ENCODED_BYTES },
      },
    ];
  }
  return [];
};

const retentionRule: DraftBaseRule = ({ config }) => {
  const issues: DraftIssue[] = [];
  if (config.records.nonHitRetentionDays > MODERATION_LIMITS.NON_HIT_RETENTION_MAX_DAYS) {
    issues.push({
      key: 'nonHitRetention',
      params: { max: MODERATION_LIMITS.NON_HIT_RETENTION_MAX_DAYS },
    });
  }
  if (config.records.hitRetentionDays < 1) issues.push({ key: 'hitRetention' });
  return issues;
};

const notifyRule: DraftBaseRule = ({ config }) => {
  if (!config.notify.enabled) return [];
  const issues: DraftIssue[] = [];
  if (config.notify.emails.length === 0) issues.push({ key: 'notifyEmailsRequired' });
  for (const email of config.notify.emails) {
    if (!EMAIL_PATTERN.test(email)) issues.push({ key: 'notifyEmailInvalid', params: { email } });
  }
  return issues;
};

const autoBanRule: DraftBaseRule = ({ config }) =>
  config.autoBan.enabled && config.autoBan.threshold < 1 ? [{ key: 'autoBanThreshold' }] : [];

/**
 * The order the issues come back in — the form reports the FIRST one, so this list decides which
 * mistake an admin is told about when several fields are wrong at once.
 */
const DRAFT_BASE_RULES: DraftBaseRule[] = [
  requestKindsRule,
  sampleRateRule,
  categoryThresholdRule,
  llmJudgeRule,
  moderationsApiRule,
  downgradeTargetRule,
  blockMessageRule,
  downgradeMessageRule,
  retentionRule,
  notifyRule,
  autoBanRule,
];

/**
 * Everything except the keyword rules. Cheap enough to run on every keystroke.
 */
export const validateDraftBase = (
  draft: ModerationSettingsDraft,
  options: DraftBaseOptions = {},
): DraftIssue[] => DRAFT_BASE_RULES.flatMap((rule) => rule(draft, options));

/**
 * Client-side mirror of the server validation (design §5). It exists so a mistake is named
 * next to the field that caused it instead of coming back as one opaque 400.
 */
export const validateDraft = (
  draft: ModerationSettingsDraft,
  options: DraftBaseOptions = {},
): DraftIssue[] => [
  ...validateDraftBase(draft, options),
  ...validateKeywordRules(draft.config.keywords),
];
