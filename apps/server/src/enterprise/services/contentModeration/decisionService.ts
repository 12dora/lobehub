import { randomUUID } from 'node:crypto';

import type {
  ModerationCategory,
  ModerationCategoryAction,
  ModerationDecisionSource,
  ModerationEffectiveAction,
  ModerationRequestKind,
} from '@/const/platform/contentModeration';
import type { LobeChatDatabase } from '@/database/type';
import type { ContentModerationConfig, KeywordRule } from '@/types/platform/contentModeration';

import { createLlmJudgeClassifier } from './classifiers/llmJudge';
import {
  createModerationsApiClassifier,
  loadModerationApiKeys,
} from './classifiers/moderationsApi';
import { type Classifier, toClassifierErrorCode } from './classifiers/types';
import { collectJudgment } from './collectJudgment';
import { MODERATION_DEDUPE_MAX_ENTRIES, MODERATION_DEDUPE_WINDOW_MS } from './constants';
import { maybeSkipEvaluation } from './evaluateSkip';
import { hashPrompt } from './normalize';
import { computePolicyAction, emptyCategoryScores, mapPolicyToEffective } from './policy';
import { obtainPlatformSecretService } from './secrets';
import { getModerationSnapshot, type ModerationSnapshot } from './settingsSnapshot';
import { getUserPlatformRoleNames } from './userRoles';

export interface EvaluatePromptInput {
  messageId?: string;
  model: string;
  provider: string;
  requestId?: string;
  requestKind: ModerationRequestKind;
  /** When the caller already loaded the snapshot, reuse it (one fetch per message). */
  snapshot?: ModerationSnapshot | null;
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

const dropInflight = (key: string, inflight: Promise<CachedJudgment>) => {
  const current = dedupe.get(key);
  if (current?.kind === 'inflight' && current.promise === inflight) {
    dedupe.delete(key);
  }
};

const makeJudgment = (params: {
  error?: string;
  hash: string;
  latencyMs: number;
  matchedRule?: KeywordRule;
  now: number;
  scores: Record<ModerationCategory, number>;
  source: ModerationDecisionSource;
}): CachedJudgment => ({
  error: params.error,
  expiresAt: params.now + MODERATION_DEDUPE_WINDOW_MS,
  hash: params.hash,
  latencyMs: params.latencyMs,
  matchedRule: params.matchedRule,
  recordId: randomUUID(),
  scores: params.scores,
  source: params.source,
});

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

  const snapshot = input.snapshot ?? (await getSnapshot(db));
  const { config } = snapshot;

  const roles = config.mode === 'off' ? [] : await getRoles(db, input.userId);
  const skipped = maybeSkipEvaluation(config, input, roles);
  if (skipped) return skipped;

  const hash = hashPrompt(input.text);
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

  try {
    const collected = await collectJudgment({
      classify,
      config,
      db,
      getDecision: deps.getDecision,
      hash,
      matcher: snapshot.matcher,
      text: input.text,
    });
    const judgment = makeJudgment({
      error: collected.error,
      hash,
      latencyMs: now() - started,
      matchedRule: collected.matchedRule,
      now: now(),
      scores: collected.scores,
      source: collected.source,
    });
    if (collected.error) {
      dropInflight(dedupeKey, inflight);
    } else {
      rememberReady(dedupeKey, judgment);
    }
    resolveInflight(judgment);
    return toDecision({ config, input, judgment, reused: false });
  } catch (caught) {
    const code = toClassifierErrorCode(caught);
    const judgment = makeJudgment({
      error: code,
      hash,
      latencyMs: now() - started,
      now: now(),
      scores: emptyCategoryScores(),
      source: config.classifier.kind === 'llm_judge' ? 'llm_judge' : 'moderations_api',
    });
    dropInflight(dedupeKey, inflight);
    resolveInflight(judgment);
    console.error('[content-moderation] classifier failed', {
      code,
      errorClass: caught instanceof Error ? caught.name : 'UnknownError',
    });
    return toDecision({ config, input, judgment, reused: false });
  }
};
