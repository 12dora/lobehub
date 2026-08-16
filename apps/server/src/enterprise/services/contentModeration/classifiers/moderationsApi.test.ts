import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPENAI_MODERATION_CATEGORY_MAP } from '@/const/platform/contentModeration';

import {
  createMemoryKeyHealthPool,
  createModerationsApiClassifier,
  createNoopKeyHealthPool,
  resetModerationKeyPoolForTest,
} from './moderationsApi';
import { ClassifierInvalidResponseError } from './types';

const completeOpenAiScores = (overrides: Record<string, number> = {}): Record<string, number> => {
  const scores: Record<string, number> = {};
  for (const key of Object.keys(OPENAI_MODERATION_CATEGORY_MAP)) scores[key] = 0;
  return { ...scores, ...overrides };
};

afterEach(() => {
  resetModerationKeyPoolForTest();
});

const keys = [
  { fingerprint: 'aaa', plaintext: 'sk-aaa' },
  { fingerprint: 'bbb', plaintext: 'sk-bbb' },
];

describe('createModerationsApiClassifier', () => {
  it('maps OpenAI category_scores onto platform categories', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                category_scores: completeOpenAiScores({
                  'sexual': 0.8,
                  'violence/graphic': 0.4,
                }),
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const classifier = createModerationsApiClassifier({
      apiKeys: keys,
      baseUrl: 'https://api.openai.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      model: 'omni-moderation-latest',
      retryCount: 0,
      timeoutMs: 1000,
    });
    const result = await classifier.classify('hello');
    expect(result.scores.sexual).toBe(0.8);
    expect(result.scores.violence).toBe(0.4);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('freezes a key for 10 minutes on 401 and tries the next key', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('no', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ results: [{ category_scores: completeOpenAiScores({ sexual: 0.1 }) }] }),
          {
            status: 200,
          },
        ),
      );
    const classifier = createModerationsApiClassifier({
      apiKeys: keys,
      baseUrl: 'https://api.openai.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      model: 'omni-moderation-latest',
      retryCount: 1,
      timeoutMs: 1000,
    });
    const result = await classifier.classify('hello');
    expect(result.scores.sexual).toBe(0.1);
    const firstAuth = (fetchImpl.mock.calls[0]?.[1] as { headers: { Authorization: string } })
      .headers.Authorization;
    const secondAuth = (fetchImpl.mock.calls[1]?.[1] as { headers: { Authorization: string } })
      .headers.Authorization;
    expect(firstAuth).not.toBe(secondAuth);
  });

  it('retries 5xx with backoff', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('no', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ category_scores: completeOpenAiScores() }] }), {
          status: 200,
        }),
      );
    const classifier = createModerationsApiClassifier({
      apiKeys: keys,
      baseUrl: 'https://api.openai.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      model: 'omni-moderation-latest',
      retryCount: 1,
      timeoutMs: 1000,
    });
    const pending = classifier.classify('hello');
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not retry a 400', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }));
    const classifier = createModerationsApiClassifier({
      apiKeys: keys,
      baseUrl: 'https://api.openai.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      model: 'omni-moderation-latest',
      retryCount: 3,
      timeoutMs: 1000,
    });
    await expect(classifier.classify('hello')).rejects.toThrow(/MODERATIONS_API_400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws ClassifierInvalidResponseError when category_scores is missing or empty', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ results: [{}] }), { status: 200 }),
    );
    const classifier = createModerationsApiClassifier({
      apiKeys: keys,
      baseUrl: 'https://api.openai.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      model: 'omni-moderation-latest',
      retryCount: 2,
      timeoutMs: 1000,
    });
    await expect(classifier.classify('hello')).rejects.toBeInstanceOf(
      ClassifierInvalidResponseError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws ClassifierInvalidResponseError when category_scores is {}', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [{ category_scores: {} }] }), { status: 200 }),
    );
    const classifier = createModerationsApiClassifier({
      apiKeys: keys,
      baseUrl: 'https://api.openai.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      model: 'omni-moderation-latest',
      retryCount: 0,
      timeoutMs: 1000,
    });
    await expect(classifier.classify('hello')).rejects.toBeInstanceOf(
      ClassifierInvalidResponseError,
    );
  });

  it('throws when any OPENAI_MODERATION_CATEGORY_MAP key is missing or not finite', async () => {
    const missingKey = completeOpenAiScores({ sexual: 0.2 });
    delete missingKey['violence/graphic'];
    const missingFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [{ category_scores: missingKey }] }), {
          status: 200,
        }),
    );
    const missing = createModerationsApiClassifier({
      apiKeys: keys,
      baseUrl: 'https://api.openai.com',
      fetchImpl: missingFetch as unknown as typeof fetch,
      model: 'omni-moderation-latest',
      retryCount: 0,
      timeoutMs: 1000,
    });
    await expect(missing.classify('hello')).rejects.toBeInstanceOf(ClassifierInvalidResponseError);

    const nanScores = completeOpenAiScores({ sexual: Number.NaN });
    const nanFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [{ category_scores: nanScores }] }), {
          status: 200,
        }),
    );
    const nanClassifier = createModerationsApiClassifier({
      apiKeys: keys,
      baseUrl: 'https://api.openai.com',
      fetchImpl: nanFetch as unknown as typeof fetch,
      model: 'omni-moderation-latest',
      retryCount: 0,
      timeoutMs: 1000,
    });
    await expect(nanClassifier.classify('hello')).rejects.toBeInstanceOf(
      ClassifierInvalidResponseError,
    );
  });

  it('does not freeze the shared production pool when an isolated dry-run pool is injected', async () => {
    const isolated = createMemoryKeyHealthPool();
    const dryRunFetch = vi.fn(async () => new Response('no', { status: 401 }));
    const dryRun = createModerationsApiClassifier({
      apiKeys: keys,
      baseUrl: 'https://api.openai.com',
      fetchImpl: dryRunFetch as unknown as typeof fetch,
      keyHealth: isolated,
      model: 'omni-moderation-latest',
      retryCount: 0,
      timeoutMs: 1000,
    });
    await expect(dryRun.classify('probe')).rejects.toThrow(/MODERATIONS_API_401/);

    const liveFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ results: [{ category_scores: completeOpenAiScores({ sexual: 0.2 }) }] }),
          {
            status: 200,
          },
        ),
    );
    const live = createModerationsApiClassifier({
      apiKeys: [keys[0]!],
      baseUrl: 'https://api.openai.com',
      fetchImpl: liveFetch as unknown as typeof fetch,
      model: 'omni-moderation-latest',
      retryCount: 0,
      timeoutMs: 1000,
    });
    const result = await live.classify('hello');
    expect(result.scores.sexual).toBe(0.2);
    const liveInit = liveFetch.mock.calls.at(0)?.at(1);
    expect(liveInit).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-aaa' }),
      }),
    );
  });

  it('noop pool never freezes keys even after 401', async () => {
    const now = () => 1_000;
    const pool = createNoopKeyHealthPool();
    pool.freeze('aaa', 10 * 60 * 1000, now());
    expect(pool.isFrozen('aaa', now())).toBe(false);
  });
});
