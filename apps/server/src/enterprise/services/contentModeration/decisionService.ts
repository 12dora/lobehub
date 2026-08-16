import { randomUUID } from 'node:crypto';

import type {
  ModerationCategory,
  ModerationCategoryAction,
  ModerationDecisionSource,
  ModerationEffectiveAction,
  ModerationRequestKind,
} from '@/const/platform/contentModeration';
import { PlatformContentModerationDecisionModel } from '@/database/models/platform/contentModerationDecisions';
import type { LobeChatDatabase } from '@/database/type';
import type { ContentModerationConfig, KeywordRule } from '@/types/platform/contentModeration';

import { createLlmJudgeClassifier } from './classifiers/llmJudge';
import {
  createModerationsApiClassifier,
  loadModerationApiKeys,
} from './classifiers/moderationsApi';
import { type Classifier, toClassifierErrorCode } from './classifiers/types';
import { MODERATION_DEDUPE_MAX_ENTRIES, MODERATION_DEDUPE_WINDOW_MS } from './constants';
import { hashPrompt } from './normalize';
import {
  computePolicyAction,
  emptyCategoryScores,
  isExempt,
  isModelInScope,
  isSampled,
  mapPolicyToEffective,
} from './policy';
import { obtainPlatformSecretService } from './secrets';
import { getModerationSnapshot, type ModerationSnapshot } from './settingsSnapshot';
import { getUserPlatformRoleNames } from './userRoles';

export interface EvaluatePromptInput {
  messageId?: string;
  model: string;
  provider: string;
  requestId?: string;
  requestKind: ModerationRequestKind;
  text: string;
  topicId?: string;
  userId: string;
}

export interface SkippedDecision {
  reason: string;
  skipped: true;
}

export interface EvaluatedDecision {
  downgradeTarget?: { model: string; provider: string };
  effectiveAction: ModerationEffectiveAction;
  /**
   * True when this is a classifier error that the admin configured as a
   * user-facing block (`onError === 'block'` in enforce mode). B2 must treat
   * `enforce === true` like a block even though `effectiveAction` stays `'error'`.
   */
  enforce: boolean;
  error?: string;
  hash: string;
  latencyMs: number;
  matchedRule?: { id: string; isRegex: boolean; pattern: string };
  policyAction: ModerationCategoryAction;
  /** Stable id minted on the first evaluation and replayed from the 60s LRU. */
  recordId: string;
  /**
   * True when this decision was served from the 60s in-process LRU (same
   * userId+hash). Callers must not insert another record / hourly increment.
   */
  reused: boolean;
  scores: Record<ModerationCategory, number>;
  skipped: false;
  source: ModerationDecisionSource;
  thresholdSnapshot: ContentModerationConfig['categories'];
  topCategory: ModerationCategory | null;
  topScore: number;
}

export type Decision = EvaluatedDecision | SkippedDecision;

export type ClassifierFactory = (
  config: ContentModerationConfig,
  db: LobeChatDatabase,
) => Promise<Classifier | null>;

export interface DecisionServiceDeps {
  classify?: ClassifierFactory;
  getDecision?: (
    db: LobeChatDatabase,
    hash: string,
  ) => Promise<{
    categories: Partial<Record<ModerationCategory, number>>;
    source: ModerationDecisionSource;
  } | null>;
  getRoles?: (db: LobeChatDatabase, userId: string) => Promise<string[]>;
  getSnapshot?: (db: LobeChatDatabase) => Promise<ModerationSnapshot>;
  now?: () => number;
}

/** Raw judgment only — policy + folding are re-run on every reuse. */
interface CachedJudgment {
  error?: string;
  expiresAt: number;
  hash: string;
  latencyMs: number;
  matchedRule?: KeywordRule;
  recordId: string;
  scores: Record<ModerationCategory, number>;
  source: ModerationDecisionSource;
}

type DedupeSlot =
  | { kind: 'inflight'; promise: Promise<CachedJudgment> }
  | { kind: 'ready'; judgment: CachedJudgment };

const dedupe = new Map<string, DedupeSlot>();

const evictIfNeeded = () => {
  if (dedupe.size <= MODERATION_DEDUPE_MAX_ENTRIES) return;
  const oldest = dedupe.keys().next().value;
  if (oldest) dedupe.delete(oldest);
};

const rememberReady = (key: string, judgment: CachedJudgment) => {
  dedupe.set(key, { kind: 'ready', judgment });
  evictIfNeeded();
};

const rememberInflight = (key: string, promise: Promise<CachedJudgment>) => {
  dedupe.set(key, { kind: 'inflight', promise });
  evictIfNeeded();
};

const recall = (key: string, now: number): DedupeSlot | null => {
  const entry = dedupe.get(key);
  if (!entry) return null;
  if (entry.kind === 'inflight') return entry;
  if (entry.judgment.expiresAt <= now) {
    dedupe.delete(key);
    return null;
  }
  return entry;
};

export const resetModerationDedupeForTest = () => {
  dedupe.clear();
};

export const defaultClassifierFactory: ClassifierFactory = async (config, db) => {
  if (config.classifier.kind === 'llm_judge' && config.classifier.llmJudge) {
    return createLlmJudgeClassifier({
      db,
      extraGuidance: config.classifier.llmJudge.extraGuidance,
      model: config.classifier.llmJudge.model,
      provider: config.classifier.llmJudge.provider,
      retryCount: config.classifier.retryCount,
      timeoutMs: config.classifier.timeoutMs,
    });
  }
  if (config.classifier.kind === 'moderations_api' && config.classifier.moderationsApi) {
    const secrets = obtainPlatformSecretService();
    if (!secrets) throw new Error('MODERATIONS_API_SECRET_UNAVAILABLE');
    const apiKeys = await loadModerationApiKeys(
      secrets,
      config.classifier.moderationsApi.apiKeyRefs,
    );
    return createModerationsApiClassifier({
      apiKeys,
      baseUrl: config.classifier.moderationsApi.baseUrl,
      model: config.classifier.moderationsApi.model,
      retryCount: config.classifier.retryCount,
      timeoutMs: config.classifier.timeoutMs,
    });
  }
  return null;
};

const foldEffectiveAction = (params: {
  config: ContentModerationConfig;
  model: string;
  policyAction: ModerationCategoryAction;
  provider: string;
  requestKind: ModerationRequestKind;
}): {
  downgradeTarget?: { model: string; provider: string };
  effectiveAction: ModerationEffectiveAction;
} => {
  const effectiveAction: ModerationEffectiveAction = mapPolicyToEffective(params.policyAction);

  if (params.config.mode === 'observe') {
    return { effectiveAction: 'allow' };
  }

  if (params.policyAction !== 'downgrade') {
    return { effectiveAction };
  }

  const target = params.config.downgrade;
  if (!target || params.requestKind !== 'chat') {
    return { effectiveAction: 'block' };
  }
  if (target.provider === params.provider && target.model === params.model) {
    return { downgradeTarget: target, effectiveAction: 'log' };
  }
  return { downgradeTarget: target, effectiveAction: 'downgrade' };
};

const foldError = (
  config: ContentModerationConfig,
): { effectiveAction: ModerationEffectiveAction; enforce: boolean } => ({
  effectiveAction: 'error',
  enforce: config.mode === 'enforce' && config.classifier.onError === 'block',
});

const toDecision = (params: {
  config: ContentModerationConfig;
  input: EvaluatePromptInput;
  judgment: CachedJudgment;
  reused: boolean;
}): EvaluatedDecision => {
  const { config, input, judgment, reused } = params;

  if (judgment.error) {
    const folded = foldError(config);
    return {
      effectiveAction: folded.effectiveAction,
      enforce: folded.enforce,
      error: judgment.error,
      hash: judgment.hash,
      latencyMs: judgment.latencyMs,
      matchedRule: judgment.matchedRule
        ? {
            id: judgment.matchedRule.id,
            isRegex: judgment.matchedRule.isRegex,
            pattern: judgment.matchedRule.pattern,
          }
        : undefined,
      policyAction: 'ignore',
      recordId: judgment.recordId,
      reused,
      scores: judgment.scores,
      skipped: false,
      source: judgment.source,
      thresholdSnapshot: config.categories,
      topCategory: null,
      topScore: 0,
    };
  }

  const policy = computePolicyAction({
    categories: config.categories,
    matchedRule: judgment.matchedRule,
    scores: judgment.scores,
  });
  const folded = foldEffectiveAction({
    config,
    model: input.model,
    policyAction: policy.policyAction,
    provider: input.provider,
    requestKind: input.requestKind,
  });

  return {
    downgradeTarget: folded.downgradeTarget,
    effectiveAction: folded.effectiveAction,
    enforce: false,
    hash: judgment.hash,
    latencyMs: judgment.latencyMs,
    matchedRule: judgment.matchedRule
      ? {
          id: judgment.matchedRule.id,
          isRegex: judgment.matchedRule.isRegex,
          pattern: judgment.matchedRule.pattern,
        }
      : undefined,
    policyAction: policy.policyAction,
    recordId: judgment.recordId,
    reused,
    scores: judgment.scores,
    skipped: false,
    source: judgment.source,
    thresholdSnapshot: config.categories,
    topCategory: policy.topCategory,
    topScore: policy.topScore,
  };
};

export const evaluatePrompt = async (
  db: LobeChatDatabase,
  input: EvaluatePromptInput,
  deps: DecisionServiceDeps = {},
): Promise<Decision> => {
  const now = deps.now ?? Date.now;
  const getSnapshot = deps.getSnapshot ?? getModerationSnapshot;
  const getRoles = deps.getRoles ?? getUserPlatformRoleNames;
  const classify = deps.classify ?? defaultClassifierFactory;

  const snapshot = await getSnapshot(db);
  const { config } = snapshot;

  if (config.mode === 'off') return { reason: 'mode_off', skipped: true };

  const roles = await getRoles(db, input.userId);
  if (isExempt({ config, roles, userId: input.userId })) {
    return { reason: 'exempt', skipped: true };
  }
  if (!config.requestKinds.includes(input.requestKind)) {
    return { reason: 'request_kind', skipped: true };
  }
  if (!isModelInScope({ config, model: input.model, provider: input.provider })) {
    return { reason: 'model_scope', skipped: true };
  }

  const hash = hashPrompt(input.text);
  if (!isSampled(hash, config.scope.sampleRate)) {
    return { reason: 'not_sampled', skipped: true };
  }

  const dedupeKey = `${input.userId}:${hash}`;
  const cached = recall(dedupeKey, now());
  if (cached) {
    const judgment = cached.kind === 'inflight' ? await cached.promise : cached.judgment;
    return toDecision({ config, input, judgment, reused: true });
  }

  let resolveInflight!: (judgment: CachedJudgment) => void;
  const inflight = new Promise<CachedJudgment>((resolve) => {
    resolveInflight = resolve;
  });
  rememberInflight(dedupeKey, inflight);

  const started = now();
  let scores = emptyCategoryScores();
  let source: ModerationDecisionSource = 'none';
  let matchedRule: KeywordRule | undefined;
  let error: string | undefined;

  try {
    const keywordHit = await snapshot.matcher.matchAsync(input.text, config.categories);
    if (keywordHit) {
      scores[keywordHit.rule.category] = 1;
      source = 'keyword';
      matchedRule = keywordHit.rule;
    } else {
      const cachedDecision = deps.getDecision
        ? await deps.getDecision(db, hash)
        : config.decisionCache.enabled
          ? await new PlatformContentModerationDecisionModel(db).get(hash)
          : null;
      if (cachedDecision) {
        scores = { ...emptyCategoryScores(), ...cachedDecision.categories };
        source = 'cache';
      } else if (config.classifier.kind !== 'none') {
        try {
          const classifier = await classify(config, db);
          if (!classifier) throw new Error('CLASSIFIER_NOT_CONFIGURED');
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), config.classifier.timeoutMs);
          try {
            const result = await classifier.classify(input.text, controller.signal);
            scores = { ...emptyCategoryScores(), ...result.scores };
            source = classifier.kind === 'llm_judge' ? 'llm_judge' : 'moderations_api';
          } finally {
            clearTimeout(timer);
          }
        } catch (caught) {
          const code = toClassifierErrorCode(caught);
          error = code;
          source = config.classifier.kind === 'llm_judge' ? 'llm_judge' : 'moderations_api';
          console.error('[content-moderation] classifier failed', {
            code,
            errorClass: caught instanceof Error ? caught.name : 'UnknownError',
          });
        }
      }
    }

    const judgment: CachedJudgment = {
      error,
      expiresAt: now() + MODERATION_DEDUPE_WINDOW_MS,
      hash,
      latencyMs: now() - started,
      matchedRule,
      recordId: randomUUID(),
      scores,
      source,
    };
    if (error) {
      const current = dedupe.get(dedupeKey);
      if (current?.kind === 'inflight' && current.promise === inflight) {
        dedupe.delete(dedupeKey);
      }
    } else {
      rememberReady(dedupeKey, judgment);
    }
    resolveInflight(judgment);
    return toDecision({ config, input, judgment, reused: false });
  } catch (caught) {
    const code = toClassifierErrorCode(caught);
    const judgment: CachedJudgment = {
      error: code,
      expiresAt: now() + MODERATION_DEDUPE_WINDOW_MS,
      hash,
      latencyMs: now() - started,
      recordId: randomUUID(),
      scores,
      source: config.classifier.kind === 'llm_judge' ? 'llm_judge' : 'moderations_api',
    };
    const current = dedupe.get(dedupeKey);
    if (current?.kind === 'inflight' && current.promise === inflight) {
      dedupe.delete(dedupeKey);
    }
    resolveInflight(judgment);
    console.error('[content-moderation] classifier failed', {
      code,
      errorClass: caught instanceof Error ? caught.name : 'UnknownError',
    });
    return toDecision({ config, input, judgment, reused: false });
  }
};
