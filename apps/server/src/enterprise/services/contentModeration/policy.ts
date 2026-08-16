import {
  MODERATION_ACTION_SEVERITY,
  MODERATION_CATEGORIES,
  type ModerationCategory,
  type ModerationCategoryAction,
  OPENAI_MODERATION_CATEGORY_MAP,
} from '@/const/platform/contentModeration';
import type { ContentModerationConfig } from '@/types/platform/contentModeration';

import type { KeywordMatch } from './keywordMatcher';

export interface PolicyInput {
  categories: ContentModerationConfig['categories'];
  matchedRule?: KeywordMatch['rule'] | null;
  scores: Partial<Record<ModerationCategory, number>>;
}

export interface PolicyResult {
  policyAction: ModerationCategoryAction;
  topCategory: ModerationCategory | null;
  topScore: number;
  triggered: ModerationCategory[];
}

export const emptyCategoryScores = (): Record<ModerationCategory, number> => {
  const scores = {} as Record<ModerationCategory, number>;
  for (const category of MODERATION_CATEGORIES) scores[category] = 0;
  return scores;
};

export const maxAction = (
  left: ModerationCategoryAction,
  right: ModerationCategoryAction,
): ModerationCategoryAction =>
  MODERATION_ACTION_SEVERITY[left] >= MODERATION_ACTION_SEVERITY[right] ? left : right;

export const computePolicyAction = (input: PolicyInput): PolicyResult => {
  const triggered: ModerationCategory[] = [];
  let policyAction: ModerationCategoryAction = 'ignore';
  let topCategory: ModerationCategory | null = null;
  let topScore = 0;

  for (const category of MODERATION_CATEGORIES) {
    const score = input.scores[category] ?? 0;
    const policy = input.categories[category];
    if (score >= policy.threshold) {
      triggered.push(category);
      policyAction = maxAction(policyAction, policy.action);
    }
    if (score > topScore) {
      topScore = score;
      topCategory = category;
    }
  }

  if (input.matchedRule) {
    const ruleAction = maxAction(
      input.matchedRule.action,
      input.categories[input.matchedRule.category].action,
    );
    policyAction = maxAction(policyAction, ruleAction);
    if (!triggered.includes(input.matchedRule.category)) {
      triggered.push(input.matchedRule.category);
    }
    if (!topCategory) {
      topCategory = input.matchedRule.category;
      topScore = 1;
    }
  }

  return { policyAction, topCategory, topScore, triggered };
};

export const mapOpenAiCategoryScores = (
  raw: Record<string, number> | undefined | null,
): Record<ModerationCategory, number> => {
  const scores = emptyCategoryScores();
  if (!raw) return scores;
  for (const [source, value] of Object.entries(raw)) {
    const target = OPENAI_MODERATION_CATEGORY_MAP[source];
    if (!target || typeof value !== 'number' || Number.isNaN(value)) continue;
    scores[target] = Math.max(scores[target], Math.min(1, Math.max(0, value)));
  }
  return scores;
};

export const isExempt = (params: {
  config: ContentModerationConfig;
  roles: readonly string[];
  userId: string;
}): boolean => {
  if (params.config.scope.exemptUserIds.includes(params.userId)) return true;
  const exempt = new Set(params.config.scope.exemptRoles);
  return params.roles.some((role) => exempt.has(role));
};

export const isModelInScope = (params: {
  config: ContentModerationConfig;
  model: string;
  provider: string;
}): boolean => {
  const key = `${params.provider}/${params.model}`;
  const filter = params.config.scope.modelFilter;
  if (filter.type === 'all') return true;
  const models = new Set(filter.models);
  if (filter.type === 'include') return models.has(key);
  return !models.has(key);
};

/** Deterministic sample: first 8 hex chars of the prompt hash, mod 100 < rate. */
export const isSampled = (hash: string, sampleRate: number): boolean => {
  if (sampleRate >= 100) return true;
  if (sampleRate <= 0) return false;
  const slice = hash.slice(0, 8);
  const value = Number.parseInt(slice, 16);
  if (Number.isNaN(value)) return false;
  return value % 100 < sampleRate;
};

export const mapPolicyToEffective = (
  policyAction: ModerationCategoryAction,
): 'allow' | 'log' | 'downgrade' | 'block' => (policyAction === 'ignore' ? 'allow' : policyAction);
