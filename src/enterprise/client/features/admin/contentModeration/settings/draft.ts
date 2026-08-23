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
import type { ModerationConfigView, ModerationSettingsDraft } from './draftTypes';

// The draft shapes and the validation rules live next door; this module stays the one import
// path every caller already uses.
export type { DraftIssue, ModerationConfigView, ModerationSettingsDraft } from './draftTypes';
export {
  effectiveApiKeyCount,
  encodedHeaderLength,
  isValidKeywordRegex,
  MODERATION_BLOCK_MESSAGE_MAX,
  MODERATION_DOWNGRADE_MESSAGE_MAX,
  MODERATION_DOWNGRADE_MESSAGE_MAX_ENCODED_BYTES,
  validateDraft,
  validateDraftBase,
  validateKeywordRules,
} from './draftValidation';

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
