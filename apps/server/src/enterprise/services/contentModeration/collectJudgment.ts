import type {
  ModerationCategory,
  ModerationDecisionSource,
} from '@/const/platform/contentModeration';
import { PlatformContentModerationDecisionModel } from '@/database/models/platform/contentModerationDecisions';
import type { LobeChatDatabase } from '@/database/type';
import type { ContentModerationConfig, KeywordRule } from '@/types/platform/contentModeration';

import { toClassifierErrorCode } from './classifiers/types';
import type { ClassifierFactory, DecisionServiceDeps } from './decisionService';
import type { CompiledKeywordMatcher } from './keywordMatcher';
import { emptyCategoryScores } from './policy';

export interface CollectedJudgment {
  error?: string;
  matchedRule?: KeywordRule;
  scores: Record<ModerationCategory, number>;
  source: ModerationDecisionSource;
}

type ClassifierRun =
  | { scores: Record<ModerationCategory, number>; source: ModerationDecisionSource }
  | { caught: unknown; error: string; source: ModerationDecisionSource };

const runClassifier = async (
  classify: ClassifierFactory,
  config: ContentModerationConfig,
  db: LobeChatDatabase,
  text: string,
): Promise<ClassifierRun> => {
  try {
    const classifier = await classify(config, db);
    if (!classifier) throw new Error('CLASSIFIER_NOT_CONFIGURED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.classifier.timeoutMs);
    try {
      const result = await classifier.classify(text, controller.signal);
      return {
        scores: { ...emptyCategoryScores(), ...result.scores },
        source: classifier.kind === 'llm_judge' ? 'llm_judge' : 'moderations_api',
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (caught) {
    return {
      caught,
      error: toClassifierErrorCode(caught),
      source: config.classifier.kind === 'llm_judge' ? 'llm_judge' : 'moderations_api',
    };
  }
};

export const collectJudgment = async (params: {
  classify: ClassifierFactory;
  config: ContentModerationConfig;
  db: LobeChatDatabase;
  getDecision?: DecisionServiceDeps['getDecision'];
  hash: string;
  matcher: CompiledKeywordMatcher;
  text: string;
}): Promise<CollectedJudgment> => {
  const { classify, config, db, getDecision, hash, matcher, text } = params;

  let scores = emptyCategoryScores();
  let source: ModerationDecisionSource = 'none';
  let matchedRule: KeywordRule | undefined;
  let error: string | undefined;

  const keywordHit = await matcher.matchAsync(text, config.categories);
  if (keywordHit) {
    scores[keywordHit.rule.category] = 1;
    source = 'keyword';
    matchedRule = keywordHit.rule;
  } else {
    const cachedDecision = getDecision
      ? await getDecision(db, hash)
      : config.decisionCache.enabled
        ? await new PlatformContentModerationDecisionModel(db).get(hash)
        : null;
    if (cachedDecision) {
      scores = { ...emptyCategoryScores(), ...cachedDecision.categories };
      source = 'cache';
    } else if (config.classifier.kind !== 'none') {
      const classified = await runClassifier(classify, config, db, text);
      if ('error' in classified) {
        error = classified.error;
        source = classified.source;
        console.error('[content-moderation] classifier failed', {
          code: classified.error,
          errorClass: classified.caught instanceof Error ? classified.caught.name : 'UnknownError',
        });
      } else {
        scores = classified.scores;
        source = classified.source;
      }
    }
  }

  return { error, matchedRule, scores, source };
};
