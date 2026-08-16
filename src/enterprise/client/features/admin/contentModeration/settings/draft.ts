import {
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_ACTIONS,
  MODERATION_DEFAULT_CATEGORY_POLICY,
  MODERATION_LIMITS,
  type ModerationCategory,
  type ModerationCategoryAction,
} from '@/const/platform/contentModeration';
import type {
  ContentModerationSettingsUpdateConfig,
  ContentModerationSettingsView,
  KeywordRule,
} from '@/types/platform/contentModeration';

import { moderationEndpointChanged } from '../format';

/** Config half of the settings view (masked API keys, no revision metadata). */
export type ModerationConfigView = Omit<
  ContentModerationSettingsView,
  'revision' | 'updatedAt' | 'updatedBy'
>;

export interface ModerationSettingsDraft {
  /**
   * Plaintext Moderations API keys typed in this session. They are sent once on save and
   * never round-trip: the server returns fingerprints + masks only.
   */
  addedApiKeys: string[];
  config: ModerationConfigView;
}

const clone = <T>(value: T): T => structuredClone(value);

export const toDraft = (view: ContentModerationSettingsView): ModerationSettingsDraft => {
  const { revision: _revision, updatedAt: _updatedAt, updatedBy: _updatedBy, ...config } = view;
  return { addedApiKeys: [], config: clone(config) as ModerationConfigView };
};

/**
 * Wire payload for `updateSettings` — masked keys become `keep`, typed keys become `add`.
 *
 * When the endpoint no longer matches the one the stored keys were saved against, the server
 * refuses to reuse them (`endpoint_changed_reenter_keys`); dropping them from `keep` here keeps
 * the request valid and matches what the form already tells the admin.
 */
export const toUpdateConfig = (
  draft: ModerationSettingsDraft,
  options: { persistedBaseUrl?: string } = {},
): ContentModerationSettingsUpdateConfig => {
  const { classifier, ...rest } = draft.config;
  const moderationsApi = classifier.moderationsApi;
  const keysDropped = moderationEndpointChanged(options.persistedBaseUrl, moderationsApi?.baseUrl);
  return {
    ...rest,
    classifier: {
      kind: classifier.kind,
      llmJudge: classifier.llmJudge,
      onError: classifier.onError,
      retryCount: classifier.retryCount,
      timeoutMs: classifier.timeoutMs,
      ...(moderationsApi
        ? {
            moderationsApi: {
              apiKeys: {
                add: draft.addedApiKeys.map((key) => key.trim()).filter(Boolean),
                keep: keysDropped ? [] : moderationsApi.apiKeys.map((item) => item.fingerprint),
              },
              baseUrl: moderationsApi.baseUrl,
              model: moderationsApi.model,
            },
          }
        : {}),
    },
  } as ContentModerationSettingsUpdateConfig;
};

/**
 * Stable structural fingerprint of everything except the keyword rules (key order independent).
 *
 * Keywords are fingerprinted separately because the list is allowed to hold 10,000 rules:
 * re-serializing it on every keystroke in an unrelated field is the difference between a
 * responsive form and a frozen one. Callers memoize the two halves on their own identities.
 */
export const fingerprintDraftBase = (draft: ModerationSettingsDraft): string => {
  const { keywords: _keywords, ...rest } = draft.config;
  return JSON.stringify([sortDeep(rest), draft.addedApiKeys]);
};

/** Cheap projection of the keyword list; only recomputed when the array identity changes. */
export const fingerprintKeywords = (rules: readonly KeywordRule[]): string =>
  `${rules.length}:${JSON.stringify(rules)}`;

/** Stable structural fingerprint for the dirty check (key order independent). */
export const fingerprintDraft = (draft: ModerationSettingsDraft): string =>
  `${fingerprintDraftBase(draft)}|${fingerprintKeywords(draft.config.keywords)}`;

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => sortDeep(item));
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return Object.keys(row)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortDeep(row[key]);
        return acc;
      }, {});
  }
  return value;
};

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

export interface DraftIssue {
  /** i18n key under `admin` → `contentModeration.errors.*`. */
  key: string;
  params?: Record<string, string | number>;
}

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

/**
 * Everything except the keyword rules. Cheap enough to run on every keystroke.
 */
export const validateDraftBase = (
  draft: ModerationSettingsDraft,
  options: { persistedBaseUrl?: string } = {},
): DraftIssue[] => {
  const issues: DraftIssue[] = [];
  const { config } = draft;

  if (config.requestKinds.length === 0) issues.push({ key: 'requestKindsRequired' });

  if (config.scope.sampleRate < 0 || config.scope.sampleRate > 100) {
    issues.push({ key: 'sampleRateRange' });
  }

  for (const category of MODERATION_CATEGORIES) {
    const policy = config.categories[category];
    if (!policy) continue;
    if (policy.threshold < 0 || policy.threshold > 1) {
      issues.push({ key: 'thresholdRange', params: { category } });
    }
  }

  if (config.classifier.kind === 'llm_judge') {
    const judge = config.classifier.llmJudge;
    if (!judge?.provider || !judge?.model) issues.push({ key: 'llmJudgeRequired' });
  }
  if (config.classifier.kind === 'moderations_api') {
    const api = config.classifier.moderationsApi;
    if (!api?.baseUrl || !api?.model) issues.push({ key: 'moderationsApiRequired' });
    else if (!/^https?:\/\//.test(api.baseUrl)) issues.push({ key: 'moderationsApiUrl' });
    // Count the keys that survive the save, not the ones currently on screen.
    if (api && effectiveApiKeyCount(draft, options.persistedBaseUrl) === 0) {
      issues.push({ key: 'moderationsApiKeyRequired' });
    }
  }

  if (config.downgrade && (!config.downgrade.provider || !config.downgrade.model)) {
    issues.push({ key: 'downgradeIncomplete' });
  }

  if (config.messages.blockMessage.length > MODERATION_BLOCK_MESSAGE_MAX) {
    issues.push({ key: 'blockMessageTooLong', params: { max: MODERATION_BLOCK_MESSAGE_MAX } });
  }
  if (config.messages.downgradeMessage.length > MODERATION_DOWNGRADE_MESSAGE_MAX) {
    issues.push({
      key: 'downgradeMessageTooLong',
      params: { max: MODERATION_DOWNGRADE_MESSAGE_MAX },
    });
  } else if (
    encodedHeaderLength(config.messages.downgradeMessage) >
    MODERATION_DOWNGRADE_MESSAGE_MAX_ENCODED_BYTES
  ) {
    // Within the character cap but still too heavy once percent-encoded (CJK is 9 bytes/char).
    issues.push({
      key: 'downgradeMessageTooHeavy',
      params: { max: MODERATION_DOWNGRADE_MESSAGE_MAX_ENCODED_BYTES },
    });
  }

  if (config.records.nonHitRetentionDays > MODERATION_LIMITS.NON_HIT_RETENTION_MAX_DAYS) {
    issues.push({
      key: 'nonHitRetention',
      params: { max: MODERATION_LIMITS.NON_HIT_RETENTION_MAX_DAYS },
    });
  }
  if (config.records.hitRetentionDays < 1) issues.push({ key: 'hitRetention' });

  if (config.notify.enabled) {
    if (config.notify.emails.length === 0) issues.push({ key: 'notifyEmailsRequired' });
    for (const email of config.notify.emails) {
      if (!EMAIL_PATTERN.test(email)) issues.push({ key: 'notifyEmailInvalid', params: { email } });
    }
  }

  if (config.autoBan.enabled && config.autoBan.threshold < 1) {
    issues.push({ key: 'autoBanThreshold' });
  }

  return issues;
};

/**
 * Client-side mirror of the server validation (design §5). It exists so a mistake is named
 * next to the field that caused it instead of coming back as one opaque 400.
 */
export const validateDraft = (
  draft: ModerationSettingsDraft,
  options: { persistedBaseUrl?: string } = {},
): DraftIssue[] => [
  ...validateDraftBase(draft, options),
  ...validateKeywordRules(draft.config.keywords),
];

/** 恢复默认 for the category table — thresholds and actions together (design §3.3). */
export const defaultCategoryPolicies = (): Record<
  ModerationCategory,
  { action: ModerationCategoryAction; threshold: number }
> => clone(MODERATION_DEFAULT_CATEGORY_POLICY);

export interface ParsedKeywordImport {
  /** 1-based line numbers that could not be parsed. */
  invalidLines: number[];
  /** Rules that actually fit — already truncated to the remaining capacity. */
  rules: Omit<KeywordRule, 'id'>[];
  /** Parsed and unique, but dropped because the 10,000-rule ceiling was reached. */
  skippedByCapacity: number;
  /** Count of duplicates dropped (case-insensitive on `pattern`). */
  skippedDuplicates: number;
}

const isCategory = (value: string): value is ModerationCategory =>
  (MODERATION_CATEGORIES as readonly string[]).includes(value);

const isAction = (value: string): value is ModerationCategoryAction =>
  (MODERATION_CATEGORY_ACTIONS as readonly string[]).includes(value);

/**
 * Batch import: one rule per line, `pattern[\tcategory[\taction]]` (design §6.3.5).
 * Duplicates are compared case-insensitively against the existing rules AND within the
 * pasted block, so pasting the same list twice is a no-op instead of doubling the table.
 */
export const parseKeywordImport = (
  text: string,
  existing: readonly KeywordRule[],
  options: {
    /** Remaining room before the hard ceiling; defaults to the full limit minus `existing`. */
    capacity?: number;
    fallback?: { action: ModerationCategoryAction; category: ModerationCategory };
  } = {},
): ParsedKeywordImport => {
  const fallback = options.fallback ?? { action: 'log' as const, category: 'other' as const };
  const capacity = Math.max(
    0,
    options.capacity ?? MODERATION_LIMITS.KEYWORD_MAX_RULES - existing.length,
  );
  const seen = new Set(existing.map((rule) => rule.pattern.trim().toLowerCase()));
  const rules: Omit<KeywordRule, 'id'>[] = [];
  const invalidLines: number[] = [];
  let skippedByCapacity = 0;
  let skippedDuplicates = 0;

  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const [pattern, category, action] = trimmed.split('\t').map((part) => part.trim());
    if (!pattern || pattern.length > MODERATION_LIMITS.KEYWORD_MAX_LENGTH) {
      invalidLines.push(index + 1);
      return;
    }
    if (category && !isCategory(category)) {
      invalidLines.push(index + 1);
      return;
    }
    if (action && !isAction(action)) {
      invalidLines.push(index + 1);
      return;
    }
    const dedupeKey = pattern.toLowerCase();
    if (seen.has(dedupeKey)) {
      skippedDuplicates += 1;
      return;
    }
    seen.add(dedupeKey);
    if (rules.length >= capacity) {
      skippedByCapacity += 1;
      return;
    }
    rules.push({
      action: action && isAction(action) ? action : fallback.action,
      category: category && isCategory(category) ? category : fallback.category,
      enabled: true,
      isRegex: false,
      pattern,
    });
  });

  return { invalidLines, rules, skippedByCapacity, skippedDuplicates };
};

/** UUID for a new keyword rule; `crypto.randomUUID` is available in every supported runtime. */
export const newKeywordRuleId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
