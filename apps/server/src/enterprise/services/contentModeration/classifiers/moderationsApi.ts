import { OPENAI_MODERATION_CATEGORY_MAP } from '@/const/platform/contentModeration';
import { createSafeOutboundHttpClient } from '@/server/enterprise/security/outboundHttp';
import type { PlatformSecretService } from '@/server/enterprise/security/secret';

import { MODERATION_KEY_FREEZE_MS, MODERATION_RETRY_BACKOFF_MS } from '../constants';
import { mapOpenAiCategoryScores } from '../policy';
import { decryptModerationApiKey, fingerprintModerationApiKey } from '../secrets';
import type { Classifier, ClassifierResult } from './types';
import { ClassifierInvalidResponseError } from './types';

const OPENAI_MODERATION_SCORE_KEYS = Object.keys(OPENAI_MODERATION_CATEGORY_MAP);

const assertCompleteOpenAiScores = (raw: unknown): Record<string, number> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClassifierInvalidResponseError('MODERATIONS_API_MISSING_SCORES');
  }
  const scores = raw as Record<string, unknown>;
  for (const key of OPENAI_MODERATION_SCORE_KEYS) {
    const value = scores[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ClassifierInvalidResponseError('MODERATIONS_API_INCOMPLETE_SCORES');
    }
  }
  return scores as Record<string, number>;
};

interface FrozenKey {
  until: number;
}

export interface KeyHealthPool {
  freeze: (fingerprint: string, durationMs: number, now: number) => void;
  isFrozen: (fingerprint: string, now: number) => boolean;
}

const createMapBackedKeyHealthPool = (frozen: Map<string, FrozenKey>): KeyHealthPool => ({
  freeze: (fingerprint, durationMs, now) => {
    frozen.set(fingerprint, { until: now + durationMs });
  },
  isFrozen: (fingerprint, now) => {
    const entry = frozen.get(fingerprint);
    if (!entry) return false;
    if (entry.until <= now) {
      frozen.delete(fingerprint);
      return false;
    }
    return true;
  },
});

/** Isolated pool for a single dry-run / test — never the production freeze table. */
export const createMemoryKeyHealthPool = (): KeyHealthPool =>
  createMapBackedKeyHealthPool(new Map());

/** Never freezes keys; used when a probe must not affect rotation. */
export const createNoopKeyHealthPool = (): KeyHealthPool => ({
  freeze: () => undefined,
  isFrozen: () => false,
});

const frozenKeys = new Map<string, FrozenKey>();
const sharedKeyHealthPool = createMapBackedKeyHealthPool(frozenKeys);
let sharedRoundRobin = 0;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const joinUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/v1/moderations`;
};

export interface ModerationsApiKey {
  fingerprint: string;
  plaintext: string;
}

export interface CreateModerationsApiClassifierParams {
  apiKeys: ModerationsApiKey[];
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /**
   * Key freeze / rotation health. Defaults to the process-wide production pool.
   * Dry-runs must inject {@link createMemoryKeyHealthPool} or
   * {@link createNoopKeyHealthPool} so a probe cannot freeze live keys.
   */
  keyHealth?: KeyHealthPool;
  model: string;
  now?: () => number;
  retryCount: number;
  timeoutMs: number;
}

export const resetModerationKeyPoolForTest = () => {
  frozenKeys.clear();
  sharedRoundRobin = 0;
};

/**
 * OpenAI-compatible `/v1/moderations` client.
 *
 * SSRF: every request goes through {@link createSafeOutboundHttpClient}
 * (http/https only, DNS pin, loopback/link-local/metadata blocked unless the
 * existing outbound allowlist env is set). Tests can inject `fetchImpl`.
 */
export const createModerationsApiClassifier = (
  params: CreateModerationsApiClassifierParams,
): Classifier => {
  const client = createSafeOutboundHttpClient({
    timeoutMs: params.timeoutMs,
  });
  const now = params.now ?? Date.now;
  const keyHealth = params.keyHealth ?? sharedKeyHealthPool;
  const isolatedPool = Boolean(params.keyHealth);
  let localRoundRobin = 0;

  const readCursor = () => (isolatedPool ? localRoundRobin : sharedRoundRobin);
  const writeCursor = (value: number) => {
    if (isolatedPool) localRoundRobin = value;
    else sharedRoundRobin = value;
  };

  const pickKey = (): ModerationsApiKey => {
    if (params.apiKeys.length === 0) throw new Error('MODERATIONS_API_NO_KEYS');
    const at = now();
    const cursor = readCursor();
    for (let offset = 0; offset < params.apiKeys.length; offset += 1) {
      const index = (cursor + offset) % params.apiKeys.length;
      const key = params.apiKeys[index]!;
      if (!keyHealth.isFrozen(key.fingerprint, at)) {
        writeCursor(index + 1);
        return key;
      }
    }
    throw new Error('MODERATIONS_API_ALL_KEYS_FROZEN');
  };

  const attempt = async (text: string, signal?: AbortSignal): Promise<ClassifierResult> => {
    const started = Date.now();
    const key = pickKey();
    const url = joinUrl(params.baseUrl);
    const init = {
      body: JSON.stringify({ input: text, model: params.model }),
      headers: {
        'Authorization': `Bearer ${key.plaintext}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal,
      timeoutMs: params.timeoutMs,
    };

    const response = params.fetchImpl
      ? await params.fetchImpl(url, init)
      : await client.fetch(url, init);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        keyHealth.freeze(key.fingerprint, MODERATION_KEY_FREEZE_MS.AUTH, now());
      } else if (response.status === 429 || response.status === 529) {
        keyHealth.freeze(key.fingerprint, MODERATION_KEY_FREEZE_MS.RATE_LIMIT, now());
      } else if (response.status >= 500) {
        keyHealth.freeze(key.fingerprint, MODERATION_KEY_FREEZE_MS.SERVER, now());
      }
      // 400: no freeze, no retry. 401/403 freeze this key then retry another.
      const retryable = response.status !== 400;
      const error = new Error(`MODERATIONS_API_${response.status}`);
      (error as Error & { retryable?: boolean }).retryable = retryable;
      throw error;
    }

    const body = (await response.json()) as {
      results?: Array<{ category_scores?: Record<string, number> }>;
    };
    const raw = assertCompleteOpenAiScores(body.results?.[0]?.category_scores);
    return {
      latencyMs: Date.now() - started,
      raw: body,
      scores: mapOpenAiCategoryScores(raw),
    };
  };

  return {
    classify: async (text, signal) => {
      let lastError: unknown;
      const retries = Math.max(0, params.retryCount);
      for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex += 1) {
        try {
          return await attempt(text, signal);
        } catch (error) {
          lastError = error;
          const retryable = (error as { retryable?: boolean }).retryable !== false;
          const isAbort = error instanceof Error && error.name === 'AbortError';
          if (!retryable || isAbort || attemptIndex === retries) throw error;
          const backoff = MODERATION_RETRY_BACKOFF_MS[attemptIndex] ?? 300;
          await sleep(backoff, signal);
        }
      }
      throw lastError;
    },
    kind: 'moderations_api',
  };
};

export const loadModerationApiKeys = async (
  secretService: PlatformSecretService,
  refs: readonly string[],
): Promise<ModerationsApiKey[]> => {
  const keys: ModerationsApiKey[] = [];
  for (const ref of refs) {
    const plaintext = await decryptModerationApiKey(secretService, ref);
    keys.push({
      fingerprint: fingerprintModerationApiKey(plaintext),
      plaintext,
    });
  }
  return keys;
};
