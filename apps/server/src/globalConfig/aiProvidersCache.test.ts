import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fingerprintAiProvidersConfig,
  getCachedServerAiProvidersConfig,
  resetAiProvidersCacheForTest,
} from './aiProvidersCache';

const genServerAiProvidersConfig = vi.hoisted(() =>
  vi.fn(async () => ({ openai: { enabled: true } })),
);

vi.mock('./genServerAiProviderConfig', () => ({
  genServerAiProvidersConfig,
}));

describe('getCachedServerAiProvidersConfig', () => {
  beforeEach(() => {
    resetAiProvidersCacheForTest();
    genServerAiProvidersConfig.mockClear();
    genServerAiProvidersConfig.mockResolvedValue({ openai: { enabled: true } });
  });

  afterEach(() => {
    resetAiProvidersCacheForTest();
  });

  it('returns the same provider config on two calls within TTL and computes once', async () => {
    const specific = { openai: { enabled: true } };
    const first = await getCachedServerAiProvidersConfig(specific);
    const second = await getCachedServerAiProvidersConfig(specific);

    expect(first).toBe(second);
    expect(first).toEqual({ openai: { enabled: true } });
    expect(genServerAiProvidersConfig).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent callers', async () => {
    let resolveLoad!: (value: { openai: { enabled: boolean } }) => void;
    genServerAiProvidersConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const specific = { openai: { enabled: true } };
    const pending = Promise.all([
      getCachedServerAiProvidersConfig(specific),
      getCachedServerAiProvidersConfig(specific),
    ]);
    resolveLoad({ openai: { enabled: true } });
    const [left, right] = await pending;

    expect(left).toEqual(right);
    expect(genServerAiProvidersConfig).toHaveBeenCalledTimes(1);
  });

  it('fingerprints env model-list changes separately from the specificConfig object', () => {
    const specific = { openai: { enabled: true } };
    const before = fingerprintAiProvidersConfig(specific);
    const previous = process.env.OPENAI_MODEL_LIST;
    process.env.OPENAI_MODEL_LIST = 'gpt-test';
    const after = fingerprintAiProvidersConfig(specific);
    if (previous === undefined) {
      delete process.env.OPENAI_MODEL_LIST;
    } else {
      process.env.OPENAI_MODEL_LIST = previous;
    }
    expect(after).not.toBe(before);
  });
});
