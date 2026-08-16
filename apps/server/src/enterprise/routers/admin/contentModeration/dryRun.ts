import type {
  ModerationCategory,
  ModerationDecisionSource,
} from '@/const/platform/contentModeration';
import type { LobeChatDatabase } from '@/database/type';
import type {
  ContentModerationSettingsUpdateConfig,
  ContentModerationTestClassifierOutput,
} from '@/types/platform/contentModeration';

import { compileKeywordMatcher } from '../../../services/contentModeration/keywordMatcher';
import {
  computePolicyAction,
  emptyCategoryScores,
} from '../../../services/contentModeration/policy';
import { fingerprintModerationApiKey } from '../../../services/contentModeration/secrets';
import { logModerationFailure } from './overview';

export const TEST_CLASSIFIER_TIMEOUT_MS = 8000;

export const CLASSIFIER_ERROR_CODES = [
  'timeout',
  'unauthorized',
  'rate_limited',
  'upstream_error',
  'invalid_response',
  'not_configured',
] as const;
export type ClassifierErrorCode = (typeof CLASSIFIER_ERROR_CODES)[number];

export const sanitizeClassifierError = (error: unknown, aborted: boolean): ClassifierErrorCode => {
  if (
    aborted ||
    (error instanceof Error && (error.name === 'AbortError' || error.message === 'timeout'))
  ) {
    return 'timeout';
  }
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = /MODERATIONS_API_(\d+)/.exec(message);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (status === 401 || status === 403 || /unauthorized|forbidden/i.test(message)) {
    return 'unauthorized';
  }
  if (
    status === 429 ||
    status === 529 ||
    message.includes('ALL_KEYS_FROZEN') ||
    /rate.?limit/i.test(message)
  ) {
    return 'rate_limited';
  }
  if (
    message.includes('NO_KEYS') ||
    message.includes('RUNTIME_UNAVAILABLE') ||
    message.includes('MODEL_NOT_PUBLISHED') ||
    message.includes('not_configured')
  ) {
    return 'not_configured';
  }
  if (
    /invalid_response|JSON|parse|LLM_JUDGE_RUNTIME_UNSUPPORTED/i.test(message) ||
    status === 400
  ) {
    return 'invalid_response';
  }
  return 'upstream_error';
};

export const buildLlmJudgeDryRunParams = (params: {
  config: ContentModerationSettingsUpdateConfig;
  db: LobeChatDatabase;
  signal: AbortSignal;
}) => ({
  db: params.db,
  extraGuidance: params.config.classifier.llmJudge?.extraGuidance,
  model: params.config.classifier.llmJudge!.model,
  provider: params.config.classifier.llmJudge!.provider,
  retryCount: params.config.classifier.retryCount,
  // Passed as a variable (not an object literal) so extra `signal` is allowed
  // even before the factory type lists it. Credential resolution may still
  // finish in the background if createRuntime ignores the abort.
  signal: params.signal,
  timeoutMs: params.config.classifier.timeoutMs,
});

const classifyWithRemote = async (params: {
  config: ContentModerationSettingsUpdateConfig;
  db: LobeChatDatabase;
  plaintextKeys: readonly string[];
  signal: AbortSignal;
  text: string;
}): Promise<{
  error?: string;
  latencyMs: number;
  scores: Record<ModerationCategory, number>;
  source: Extract<ModerationDecisionSource, 'llm_judge' | 'moderations_api'>;
}> => {
  const kind = params.config.classifier.kind;
  if (kind === 'llm_judge') {
    const { createLlmJudgeClassifier } =
      await import('../../../services/contentModeration/classifiers/llmJudge');
    // Abort is forwarded on the factory params (when the type accepts `signal`)
    // and again on classify(). Credential resolution inside createRuntime may
    // still finish in the background if that factory ignores the abort.
    const classifier = createLlmJudgeClassifier(buildLlmJudgeDryRunParams(params));
    const result = await classifier.classify(params.text, params.signal);
    return { latencyMs: result.latencyMs, scores: result.scores, source: 'llm_judge' };
  }

  const { createMemoryKeyHealthPool, createModerationsApiClassifier } =
    await import('../../../services/contentModeration/classifiers/moderationsApi');
  const classifier = createModerationsApiClassifier({
    apiKeys: params.plaintextKeys.map((plaintext) => ({
      fingerprint: fingerprintModerationApiKey(plaintext),
      plaintext,
    })),
    baseUrl: params.config.classifier.moderationsApi!.baseUrl,
    keyHealth: createMemoryKeyHealthPool(),
    model: params.config.classifier.moderationsApi!.model,
    retryCount: params.config.classifier.retryCount,
    timeoutMs: params.config.classifier.timeoutMs,
  });
  const result = await classifier.classify(params.text, params.signal);
  return { latencyMs: result.latencyMs, scores: result.scores, source: 'moderations_api' };
};

const runClassifierDryRunBody = async (params: {
  abort: AbortController;
  config: ContentModerationSettingsUpdateConfig;
  db: LobeChatDatabase;
  plaintextKeys: readonly string[];
  started: number;
  text: string;
}): Promise<ContentModerationTestClassifierOutput> => {
  if (params.abort.signal.aborted) {
    throw Object.assign(new Error('timeout'), { name: 'AbortError' });
  }

  const matcher = compileKeywordMatcher(params.config.keywords);
  const matched = await matcher.matchAsync(params.text);
  if (matched) {
    const scores = emptyCategoryScores();
    scores[matched.rule.category] = 1;
    const policy = computePolicyAction({
      categories: params.config.categories,
      matchedRule: matched.rule,
      scores,
    });
    return {
      latencyMs: Date.now() - params.started,
      matchedRule: { id: matched.rule.id, pattern: matched.rule.pattern },
      policyAction: policy.policyAction,
      scores,
      source: 'keyword',
    };
  }

  if (params.config.classifier.kind === 'none') {
    const scores = emptyCategoryScores();
    const policy = computePolicyAction({
      categories: params.config.categories,
      scores,
    });
    return {
      latencyMs: Date.now() - params.started,
      policyAction: policy.policyAction,
      scores,
      source: 'none',
    };
  }

  const remote = await classifyWithRemote({
    config: params.config,
    db: params.db,
    plaintextKeys: params.plaintextKeys,
    signal: params.abort.signal,
    text: params.text,
  });
  const policy = computePolicyAction({
    categories: params.config.categories,
    scores: remote.scores,
  });
  return {
    error: remote.error,
    latencyMs: remote.latencyMs,
    policyAction: policy.policyAction,
    scores: remote.scores,
    source: remote.source,
  };
};

export const runClassifierDryRun = async (params: {
  config: ContentModerationSettingsUpdateConfig;
  db: LobeChatDatabase;
  plaintextKeys: readonly string[];
  text: string;
}): Promise<ContentModerationTestClassifierOutput> => {
  const started = Date.now();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
    }, TEST_CLASSIFIER_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      runClassifierDryRunBody({
        abort,
        config: params.config,
        db: params.db,
        plaintextKeys: params.plaintextKeys,
        started,
        text: params.text,
      }),
      timeout,
    ]);
  } catch (error) {
    const latencyMs = Date.now() - started;
    const timedOut =
      abort.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    const code = sanitizeClassifierError(error, timedOut);
    logModerationFailure('classifier dry-run failed', error, code);
    const scores = emptyCategoryScores();
    const policy = computePolicyAction({
      categories: params.config.categories,
      scores,
    });
    return {
      error: code,
      latencyMs,
      policyAction: params.config.classifier.onError === 'block' ? 'block' : policy.policyAction,
      scores,
      source:
        params.config.classifier.kind === 'none'
          ? 'none'
          : params.config.classifier.kind === 'llm_judge'
            ? 'llm_judge'
            : 'moderations_api',
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (!abort.signal.aborted) abort.abort();
  }
};
