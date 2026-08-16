// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { LobeChatDatabase } from '@/database/type';
import {
  type ContentModerationSettingsUpdateConfig,
  createDefaultContentModerationConfig,
  type KeywordRule,
} from '@/types/platform/contentModeration';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import {
  assertCombinedApiKeyBound,
  assertKeywordRegexesSafe,
  assertRetainedKeysBoundToPersistedEndpoint,
  assertStatsRange,
  assertStatsTimeZone,
  buildLlmJudgeDryRunParams,
  collectOverviewWarnings,
  logModerationFailure,
  normalizeModerationBaseUrl,
  runClassifierDryRun,
  sanitizeClassifierError,
  STATS_MAX_RANGE_MS,
  statsBucketForRange,
  summarizeSettingsDiff,
} from './contentModerationSupport';

const createLlmJudgeClassifierMock = vi.hoisted(() => vi.fn());

vi.mock('../../services/contentModeration/classifiers/llmJudge', () => ({
  createLlmJudgeClassifier: (params: { retryCount?: number }) =>
    createLlmJudgeClassifierMock(params),
}));

describe('contentModerationSupport', () => {
  it('flags overview warnings for bypass, missing downgrade, and missing classifier', () => {
    const config = createDefaultContentModerationConfig();
    config.mode = 'enforce';
    config.categories.jailbreak.action = 'downgrade';
    config.downgrade = null;
    config.classifier.kind = 'none';
    config.keywords = [];

    expect(collectOverviewWarnings({ clientFetchBypass: true, config })).toEqual([
      'client_fetch_bypass',
      'downgrade_not_configured',
      'classifier_not_configured',
    ]);
  });

  it('summarizes changed top-level sections without secret material', () => {
    const previous = createDefaultContentModerationConfig();
    const next = createDefaultContentModerationConfig();
    next.mode = 'observe';
    next.classifier = {
      ...next.classifier,
      kind: 'moderations_api',
      moderationsApi: {
        apiKeyRefs: ['enc:sk-aaa'],
        baseUrl: 'https://api.openai.com',
        model: 'omni-moderation-latest',
      },
    };

    expect(summarizeSettingsDiff({ next, previous })).toEqual({
      apiKeyCount: 1,
      changedSections: ['classifier', 'mode'],
      keywordCount: 0,
    });
  });

  it('picks hour buckets for ≤3 days and rejects ranges longer than 400 days', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    expect(statsBucketForRange(from, new Date('2026-01-03T00:00:00.000Z'))).toBe('hour');
    expect(statsBucketForRange(from, new Date('2026-01-05T00:00:00.000Z'))).toBe('day');

    expect(() => assertStatsRange(from, new Date('2024-01-01T00:00:00.000Z'))).toThrow();
    expect(() => assertStatsRange(from, new Date('2027-06-01T00:00:00.000Z'))).toThrow();

    const exact = new Date(from.getTime() + STATS_MAX_RANGE_MS);
    expect(() => assertStatsRange(from, exact)).not.toThrow();
    expect(() => assertStatsRange(from, new Date(exact.getTime() + 1))).toThrow();
    expect(() => assertStatsTimeZone('UTC')).not.toThrow();
    expect(() => assertStatsTimeZone('Not/AZone')).toThrow();
  });

  it('normalizes Moderations endpoints by host case and trailing slash', () => {
    expect(normalizeModerationBaseUrl('https://API.openai.com/')).toBe('https://api.openai.com');
    expect(normalizeModerationBaseUrl('https://api.openai.com')).toBe('https://api.openai.com');
  });

  it('rejects retained keys when the submitted endpoint differs from the stored one', () => {
    expect(() =>
      assertRetainedKeysBoundToPersistedEndpoint({
        keep: ['abcd'],
        persistedBaseUrl: 'https://api.openai.com',
        submittedBaseUrl: 'https://attacker.example',
      }),
    ).toThrow();
    expect(() =>
      assertRetainedKeysBoundToPersistedEndpoint({
        keep: ['abcd'],
        persistedBaseUrl: 'https://api.openai.com',
        submittedBaseUrl: 'https://API.openai.com/',
      }),
    ).not.toThrow();
  });

  it('rejects combined keep + add above 20', () => {
    expect(() =>
      assertCombinedApiKeyBound(
        Array.from({ length: 20 }, (_, i) => `k${i}`),
        ['new'],
      ),
    ).toThrow();
    expect(() => assertCombinedApiKeyBound(['a'], ['b'])).not.toThrow();
  });

  it('rejects wrapped unsafe regexes statically and a+a+$ as slow', async () => {
    const regexRule = (pattern: string, index = 0): KeywordRule => ({
      action: 'block',
      category: 'other',
      enabled: true,
      id: `11111111-1111-4111-8111-11111111111${index}`,
      isRegex: true,
      pattern,
    });

    const wrapped = await assertKeywordRegexesSafe({ next: [regexRule('((a|a)*)')] }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(getEnterpriseErrorBody(wrapped)).toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      details: { field: 'keywords', index: 0, reason: 'regex_unsafe' },
    });

    const slow = await assertKeywordRegexesSafe({ next: [regexRule('a+a+$')] }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(getEnterpriseErrorBody(slow)).toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      details: { field: 'keywords', index: 0, reason: 'regex_slow' },
    });

    await expect(
      assertKeywordRegexesSafe({
        next: [regexRule('foo.*bar')],
        previous: [regexRule('foo.*bar')],
      }),
    ).resolves.toBeUndefined();
  });

  it('maps classifier failures to finite sanitized codes', () => {
    expect(
      sanitizeClassifierError(Object.assign(new Error('timeout'), { name: 'AbortError' }), true),
    ).toBe('timeout');
    expect(sanitizeClassifierError(new Error('MODERATIONS_API_401'), false)).toBe('unauthorized');
    expect(sanitizeClassifierError(new Error('MODERATIONS_API_429'), false)).toBe('rate_limited');
    expect(sanitizeClassifierError(new Error('MODERATIONS_API_500'), false)).toBe('upstream_error');
    expect(
      sanitizeClassifierError(new Error('Unexpected JSON token Bearer sk-secret'), false),
    ).toBe('invalid_response');
    expect(sanitizeClassifierError(new Error('LLM_JUDGE_MODEL_NOT_PUBLISHED'), false)).toBe(
      'not_configured',
    );
  });

  it('passes classifier.retryCount and the abort signal into LLM judge dry-run params', () => {
    const abort = new AbortController();
    const defaults = createDefaultContentModerationConfig();
    const config = {
      ...defaults,
      classifier: {
        kind: 'llm_judge' as const,
        llmJudge: { model: 'gpt-4o', provider: 'openai' },
        onError: 'allow' as const,
        retryCount: 3,
        timeoutMs: 3000,
      },
    } satisfies ContentModerationSettingsUpdateConfig;
    const params = buildLlmJudgeDryRunParams({
      config,
      db: {} as LobeChatDatabase,
      signal: abort.signal,
    });
    expect(params.retryCount).toBe(3);
    expect(params.signal).toBe(abort.signal);
  });

  it('honours classifier.retryCount when constructing the LLM judge dry-run', async () => {
    const emptyScores = {
      hate_harassment: 0,
      illicit: 0,
      jailbreak: 0,
      other: 0,
      political: 0,
      privacy: 0,
      self_harm: 0,
      sexual: 0,
      sexual_minors: 0,
      violence: 0,
    };
    createLlmJudgeClassifierMock.mockReturnValue({
      classify: async () => ({ latencyMs: 4, scores: emptyScores }),
      kind: 'llm_judge',
    });
    const defaults = createDefaultContentModerationConfig();
    await runClassifierDryRun({
      config: {
        ...defaults,
        classifier: {
          kind: 'llm_judge',
          llmJudge: { model: 'gpt-4o', provider: 'openai' },
          onError: defaults.classifier.onError,
          retryCount: 4,
          timeoutMs: 3000,
        },
      },
      db: {} as LobeChatDatabase,
      plaintextKeys: [],
      text: 'hello world this is a dry run',
    });
    expect(createLlmJudgeClassifierMock).toHaveBeenCalledWith(
      expect.objectContaining({ retryCount: 4 }),
    );
  });

  it('logs only a finite code and error class, never exception text', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logModerationFailure(
      'classifier dry-run failed',
      new Error('Bearer sk-abc leaked prompt text'),
      'unauthorized',
    );
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain('sk-abc');
    expect(logged).not.toContain('leaked prompt');
    expect(logged).toContain('unauthorized');
    expect(logged).toContain('Error');
    spy.mockRestore();
  });
});
