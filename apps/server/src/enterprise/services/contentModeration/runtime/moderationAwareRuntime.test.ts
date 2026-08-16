// @vitest-environment node
import { ModelRuntime } from '@lobechat/model-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MODERATION_HEADER_ACTION_DOWNGRADE,
  MODERATION_HEADERS,
} from '@/const/platform/contentModeration';

import { ContentModerationBlockedError } from './blockedError';
import { createModerationAwareRuntime } from './moderationAwareRuntime';
import {
  MODERATION_DOWNGRADE_OPTION_KEY,
  type ModerationDecision,
  type ModerationRuntimeDeps,
  type ModerationSnapshot,
  type WrapModelRuntimeContext,
} from './types';

const db = { queryCount: 0 } as never;

const ctx: WrapModelRuntimeContext = {
  db,
  provider: 'openai',
  userId: 'user-1',
};

const chatPayload = {
  messages: [{ content: 'hello world', role: 'user' as const }],
  model: 'gpt-4o',
};

const makeRuntime = (overrides?: {
  chat?: ReturnType<typeof vi.fn>;
  createImage?: ReturnType<typeof vi.fn>;
  createVideo?: ReturnType<typeof vi.fn>;
  embeddings?: ReturnType<typeof vi.fn>;
}) => {
  const chat = overrides?.chat ?? vi.fn().mockResolvedValue(new Response('ok'));
  const createImage = overrides?.createImage ?? vi.fn().mockResolvedValue({ imageUrl: 'img' });
  const createVideo = overrides?.createVideo ?? vi.fn().mockResolvedValue({ inferenceId: 'v1' });
  const embeddings = overrides?.embeddings ?? vi.fn().mockResolvedValue([[1]]);
  const inner = { chat, createImage, createVideo, embeddings };
  return { embeddings, inner, runtime: new ModelRuntime(inner as never) };
};

const evaluated = (
  effectiveAction: 'allow' | 'log' | 'downgrade' | 'block' | 'error',
  extra: Partial<Extract<ModerationDecision, { skipped: false }>> = {},
): ModerationDecision => ({
  effectiveAction,
  skipped: false,
  topCategory: 'jailbreak',
  ...extra,
});

const snapshot = (mode: 'off' | 'observe' | 'enforce' = 'enforce'): ModerationSnapshot => ({
  config: {
    messages: {
      blockMessage: 'Blocked by admin.',
      downgradeMessage: 'Downgraded to {{model}}',
      showCategoryToUser: true,
    },
    mode,
  },
});

const makeDeps = (
  overrides: Partial<ModerationRuntimeDeps> & Pick<ModerationRuntimeDeps, 'evaluate'>,
): ModerationRuntimeDeps => ({
  createRecordId: () => 'rec-1',
  extractGenerationPrompt: (payload) => {
    const prompt = (payload as { params?: { prompt?: string } }).params?.prompt;
    return prompt ?? null;
  },
  extractPromptText: () => 'hello world',
  getSnapshot: async () => snapshot(),
  initRuntime: vi.fn(),
  logger: { error: vi.fn() },
  record: vi.fn(),
  ...overrides,
});

describe('createModerationAwareRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the original runtime when skipModeration is set', () => {
    const { runtime } = makeRuntime();
    const wrapped = createModerationAwareRuntime(
      runtime,
      { ...ctx, skipModeration: true },
      makeDeps({ evaluate: vi.fn() }),
    );
    expect(wrapped).toBe(runtime);
  });

  it('forwards chat unchanged on skip and does not record', async () => {
    const { inner, runtime } = makeRuntime();
    const record = vi.fn();
    const evaluate = vi.fn(async () => ({ reason: 'off', skipped: true as const }));
    const wrapped = createModerationAwareRuntime(runtime, ctx, makeDeps({ evaluate, record }));

    await expect(wrapped.chat(chatPayload)).resolves.toBeInstanceOf(Response);
    expect(inner.chat).toHaveBeenCalledOnce();
    expect(record).not.toHaveBeenCalled();
  });

  it('forwards and records on allow / log', async () => {
    const { inner, runtime } = makeRuntime();
    const record = vi.fn();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({ evaluate: async () => evaluated('allow'), record }),
    );

    await wrapped.chat(chatPayload);
    expect(inner.chat).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ recordId: 'rec-1', requestKind: 'chat' }),
      expect.objectContaining({ effectiveAction: 'allow' }),
    );
  });

  it('blocks with the configured message, category, and recordId', async () => {
    const { inner, runtime } = makeRuntime();
    const record = vi.fn();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({ evaluate: async () => evaluated('block'), record }),
    );

    await expect(wrapped.chat(chatPayload)).rejects.toMatchObject({
      category: 'jailbreak',
      errorType: 'PLATFORM_CONTENT_MODERATION_BLOCKED',
      message: 'Blocked by admin.',
      recordId: 'rec-1',
    });
    expect(inner.chat).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledOnce();
  });

  it('omits category on block when showCategoryToUser is false', async () => {
    const { runtime } = makeRuntime();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () => evaluated('block'),
        getSnapshot: async () => ({
          config: {
            messages: { blockMessage: 'Nope', showCategoryToUser: false },
            mode: 'enforce',
          },
        }),
      }),
    );

    await expect(wrapped.chat(chatPayload)).rejects.toBeInstanceOf(ContentModerationBlockedError);
    await expect(wrapped.chat(chatPayload)).rejects.not.toHaveProperty('category', 'jailbreak');
    const error = await wrapped.chat(chatPayload).catch((thrown) => thrown);
    expect(error.category).toBeUndefined();
  });

  it('same-provider downgrade rewrites payload.model and attaches headers', async () => {
    const { inner, runtime } = makeRuntime();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () =>
          evaluated('downgrade', { downgradeTarget: { model: 'gpt-4o-mini', provider: 'openai' } }),
      }),
    );

    const response = await wrapped.chat({ ...chatPayload });
    expect(inner.chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o-mini' }),
      undefined,
    );
    expect(response.headers.get(MODERATION_HEADERS.ACTION)).toBe(
      MODERATION_HEADER_ACTION_DOWNGRADE,
    );
    expect(response.headers.get(MODERATION_HEADERS.PROVIDER)).toBe('openai');
    expect(response.headers.get(MODERATION_HEADERS.MODEL)).toBe('gpt-4o-mini');
    expect(response.headers.get(MODERATION_HEADERS.CATEGORY)).toBe('jailbreak');
    expect(response.headers.get(MODERATION_HEADERS.RECORD)).toBe('rec-1');
  });

  it('cross-provider downgrade inits a skip-moderation runtime and forwards the stream', async () => {
    const { inner, runtime } = makeRuntime();
    const downgradeChat = vi.fn().mockResolvedValue(new Response('downgraded'));
    const initRuntime = vi.fn(async () => ({ chat: downgradeChat }) as never);
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () =>
          evaluated('downgrade', { downgradeTarget: { model: 'haiku', provider: 'anthropic' } }),
        initRuntime,
      }),
    );

    const response = await wrapped.chat(chatPayload);
    expect(inner.chat).not.toHaveBeenCalled();
    expect(initRuntime).toHaveBeenCalledWith('anthropic');
    expect(downgradeChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'haiku' }),
      undefined,
    );
    expect(response.headers.get(MODERATION_HEADERS.PROVIDER)).toBe('anthropic');
    expect(response.headers.get(MODERATION_HEADERS.MODEL)).toBe('haiku');
  });

  it('stashes a downgrade marker on options and persists only after the upstream call succeeds', async () => {
    const persistDowngrade = vi.fn();
    const chat = vi.fn().mockResolvedValue(new Response('ok'));
    const { runtime } = makeRuntime({ chat });
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () =>
          evaluated('downgrade', { downgradeTarget: { model: 'gpt-4o-mini', provider: 'openai' } }),
        persistDowngrade,
      }),
    );

    const options = { metadata: { assistantMessageId: 'asst-1' } };
    await wrapped.chat(chatPayload, options as never);
    expect(options).toMatchObject({
      [MODERATION_DOWNGRADE_OPTION_KEY]: {
        action: 'downgrade',
        message: 'Downgraded to {{model}}',
        model: 'gpt-4o-mini',
        originalModel: 'gpt-4o',
        originalProvider: 'openai',
        provider: 'openai',
        recordId: 'rec-1',
      },
    });
    expect(persistDowngrade).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'downgrade',
        message: 'Downgraded to {{model}}',
        model: 'gpt-4o-mini',
      }),
      'asst-1',
    );
    expect(chat.mock.invocationCallOrder[0]).toBeLessThan(
      persistDowngrade.mock.invocationCallOrder[0]!,
    );
  });

  it('does not persist downgrade metadata when the target chat rejects', async () => {
    const persistDowngrade = vi.fn();
    const { inner, runtime } = makeRuntime();
    const targetChat = vi.fn().mockRejectedValue(new Error('target 503'));
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () =>
          evaluated('downgrade', { downgradeTarget: { model: 'haiku', provider: 'anthropic' } }),
        initRuntime: async () => ({ chat: targetChat }) as never,
        persistDowngrade,
      }),
    );

    await expect(
      wrapped.chat(chatPayload, { metadata: { assistantMessageId: 'asst-1' } } as never),
    ).rejects.toThrow('target 503');
    expect(persistDowngrade).not.toHaveBeenCalled();
    expect(inner.chat).not.toHaveBeenCalled();
  });

  it('propagates a cross-provider target rejection without calling the original runtime', async () => {
    const { inner, runtime } = makeRuntime();
    const targetChat = vi.fn().mockRejectedValue(new Error('target 503'));
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () =>
          evaluated('downgrade', { downgradeTarget: { model: 'haiku', provider: 'anthropic' } }),
        initRuntime: async () => ({ chat: targetChat }) as never,
      }),
    );

    await expect(wrapped.chat(chatPayload)).rejects.toThrow('target 503');
    expect(inner.chat).not.toHaveBeenCalled();
    expect(targetChat).toHaveBeenCalledOnce();
  });

  it('propagates a same-provider upstream rejection and calls chat exactly once', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('upstream 500'));
    const { runtime } = makeRuntime({ chat });
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () =>
          evaluated('downgrade', { downgradeTarget: { model: 'gpt-4o-mini', provider: 'openai' } }),
      }),
    );

    await expect(wrapped.chat(chatPayload)).rejects.toThrow('upstream 500');
    expect(chat).toHaveBeenCalledOnce();
  });

  it('treats enforce (classifier onError:block) as a 403 and still records the error row', async () => {
    const { inner, runtime } = makeRuntime();
    const record = vi.fn();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () =>
          evaluated('error', { enforce: true, error: 'classifier down', recordId: 'rec-en' }),
        getSnapshot: async () => ({
          config: {
            messages: { blockMessage: '', showCategoryToUser: true },
            mode: 'enforce',
          },
        }),
        record,
      }),
    );

    await expect(wrapped.chat(chatPayload)).rejects.toMatchObject({
      errorType: 'PLATFORM_CONTENT_MODERATION_BLOCKED',
      message: '',
      recordId: 'rec-en',
    });
    expect(inner.chat).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ recordId: 'rec-en' }),
      expect.objectContaining({ effectiveAction: 'error', enforce: true }),
    );
  });

  it('does not record an enforce decision when reused', async () => {
    const { inner, runtime } = makeRuntime();
    const record = vi.fn();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () =>
          evaluated('error', { enforce: true, recordId: 'rec-en', reused: true }),
        record,
      }),
    );

    await expect(wrapped.chat(chatPayload)).rejects.toMatchObject({
      errorType: 'PLATFORM_CONTENT_MODERATION_BLOCKED',
      recordId: 'rec-en',
    });
    expect(inner.chat).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('records once for two identical blocks within the 60s reuse window', async () => {
    let n = 0;
    const record = vi.fn();
    const evaluate = vi.fn(async () => {
      n += 1;
      return evaluated('block', { recordId: 'rec-stable', reused: n > 1 });
    });
    const { runtime } = makeRuntime();
    const wrapped = createModerationAwareRuntime(runtime, ctx, makeDeps({ evaluate, record }));

    await expect(wrapped.chat(chatPayload)).rejects.toMatchObject({ recordId: 'rec-stable' });
    await expect(wrapped.chat(chatPayload)).rejects.toMatchObject({ recordId: 'rec-stable' });
    expect(record).toHaveBeenCalledOnce();
  });

  it('records once for two identical downgrades and keeps the same recordId on headers', async () => {
    let n = 0;
    const record = vi.fn();
    const evaluate = vi.fn(async () => {
      n += 1;
      return evaluated('downgrade', {
        downgradeTarget: { model: 'gpt-4o-mini', provider: 'openai' },
        recordId: 'rec-down',
        reused: n > 1,
      });
    });
    const { runtime } = makeRuntime();
    const wrapped = createModerationAwareRuntime(runtime, ctx, makeDeps({ evaluate, record }));

    const first = await wrapped.chat(chatPayload);
    const second = await wrapped.chat(chatPayload);
    expect(record).toHaveBeenCalledOnce();
    expect(first.headers.get(MODERATION_HEADERS.RECORD)).toBe('rec-down');
    expect(second.headers.get(MODERATION_HEADERS.RECORD)).toBe('rec-down');
  });

  it('puts encodeURIComponent(downgradeMessage) in the header when configured', async () => {
    const { runtime } = makeRuntime();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () =>
          evaluated('downgrade', { downgradeTarget: { model: 'gpt-4o-mini', provider: 'openai' } }),
        getSnapshot: async () => ({
          config: {
            messages: {
              downgradeMessage: 'Used {{model}} instead',
              showCategoryToUser: true,
            },
            mode: 'enforce',
          },
        }),
      }),
    );

    const response = await wrapped.chat(chatPayload);
    expect(response.headers.get(MODERATION_HEADERS.MESSAGE)).toBe(
      encodeURIComponent('Used {{model}} instead'),
    );
  });

  it('omits the downgrade header when the encoded message exceeds 2048 but still persists metadata.message', async () => {
    const persistDowngrade = vi.fn();
    const heavy = '审'.repeat(300);
    expect(encodeURIComponent(heavy).length).toBeGreaterThan(2048);
    const { runtime } = makeRuntime();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () =>
          evaluated('downgrade', { downgradeTarget: { model: 'gpt-4o-mini', provider: 'openai' } }),
        getSnapshot: async () => ({
          config: {
            messages: { downgradeMessage: heavy, showCategoryToUser: true },
            mode: 'enforce',
          },
        }),
        persistDowngrade,
      }),
    );

    const options = { metadata: { assistantMessageId: 'asst-1' } };
    const response = await wrapped.chat(chatPayload, options as never);
    expect(response.headers.get(MODERATION_HEADERS.MESSAGE)).toBeNull();
    expect(persistDowngrade).toHaveBeenCalledWith(
      expect.objectContaining({ message: heavy }),
      'asst-1',
    );
  });

  it('omits the downgrade message header and marker field when the admin string is empty', async () => {
    const persistDowngrade = vi.fn();
    const { runtime } = makeRuntime();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () =>
          evaluated('downgrade', { downgradeTarget: { model: 'gpt-4o-mini', provider: 'openai' } }),
        getSnapshot: async () => ({
          config: {
            messages: { downgradeMessage: '   ', showCategoryToUser: true },
            mode: 'enforce',
          },
        }),
        persistDowngrade,
      }),
    );

    const options = { metadata: { assistantMessageId: 'asst-1' } };
    const response = await wrapped.chat(chatPayload, options as never);
    expect(response.headers.get(MODERATION_HEADERS.MESSAGE)).toBeNull();
    expect(options).toMatchObject({
      [MODERATION_DOWNGRADE_OPTION_KEY]: expect.not.objectContaining({
        message: expect.anything(),
      }),
    });
    expect(persistDowngrade).toHaveBeenCalledWith(
      expect.not.objectContaining({ message: expect.anything() }),
      'asst-1',
    );
  });

  it('omits message from the block error body when blockMessage is empty/whitespace', async () => {
    const { runtime } = makeRuntime();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () => evaluated('block'),
        getSnapshot: async () => ({
          config: {
            messages: { blockMessage: '  ', showCategoryToUser: true },
            mode: 'enforce',
          },
        }),
      }),
    );

    const error = await wrapped.chat(chatPayload).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(ContentModerationBlockedError);
    expect(error.message).toBe('');
    expect(error.recordId).toBe('rec-1');
  });

  it.each([
    {
      args: [{ model: 'obj', schema: {} }],
      method: 'generateObject' as const,
    },
    {
      args: [{ input: 'hi', model: 'tts-1' }],
      method: 'textToSpeech' as const,
    },
    {
      args: [{ model: 'whisper-1' }],
      method: 'transcribe' as const,
    },
    {
      args: [],
      method: 'models' as const,
    },
    {
      args: [],
      method: 'getAuthHeaders' as const,
    },
  ])('forwards $method to the original runtime with bound this', async ({ args, method }) => {
    const innerImpl = {
      chat: vi.fn(),
      generateObject: vi.fn().mockResolvedValue({}),
      getAuthHeaders: vi.fn(function (this: unknown) {
        return { thisIsInner: this === innerImpl };
      }),
      models: vi.fn().mockResolvedValue([]),
      textToSpeech: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      transcribe: vi.fn().mockResolvedValue({ text: 'ok' }),
    };
    const runtime = new ModelRuntime(innerImpl as never);
    const thisValues: unknown[] = [];
    const original = runtime[method].bind(runtime);
    Object.defineProperty(runtime, method, {
      configurable: true,
      value: function (this: unknown, ...rest: unknown[]) {
        thisValues.push(this);
        return (original as (...inner: unknown[]) => unknown).apply(this, rest);
      },
    });

    const evaluate = vi.fn();
    const wrapped = createModerationAwareRuntime(runtime, ctx, makeDeps({ evaluate }));
    await (wrapped[method] as (...inner: unknown[]) => unknown)(...args);

    expect(thisValues[0]).toBe(runtime);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('treats image/video downgrade as block (B1 decision service contract)', async () => {
    const { inner, runtime } = makeRuntime();
    const evaluate = vi.fn(async () =>
      evaluated('downgrade', { downgradeTarget: { model: 'safe', provider: 'openai' } }),
    );
    const wrapped = createModerationAwareRuntime(runtime, ctx, makeDeps({ evaluate }));

    await expect(
      wrapped.createImage({ model: 'dall-e-3', params: { prompt: 'draw a nuke' } }),
    ).rejects.toBeInstanceOf(ContentModerationBlockedError);
    expect(evaluate).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ requestKind: 'image', text: 'draw a nuke' }),
    );
    expect(inner.createImage).not.toHaveBeenCalled();

    await expect(
      wrapped.createVideo({ model: 'sora', params: { prompt: 'draw a nuke' } as never }),
    ).rejects.toBeInstanceOf(ContentModerationBlockedError);
    expect(inner.createVideo).not.toHaveBeenCalled();
  });

  it('forwards createImage when the decision is allow', async () => {
    const { inner, runtime } = makeRuntime();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({ evaluate: async () => evaluated('allow') }),
    );

    await expect(
      wrapped.createImage({ model: 'dall-e-3', params: { prompt: 'a cat' } }),
    ).resolves.toEqual({ imageUrl: 'img' });
    expect(inner.createImage).toHaveBeenCalledOnce();
  });

  it('fails open when evaluate throws, and still forwards the request', async () => {
    const { inner, runtime } = makeRuntime();
    const logger = { error: vi.fn() };
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () => {
          throw new Error('classifier down sk-abc leaked prompt');
        },
        logger,
      }),
    );

    await expect(wrapped.chat(chatPayload)).resolves.toBeInstanceOf(Response);
    expect(inner.chat).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'chat moderation failed; failing open',
      expect.objectContaining({ code: expect.any(String), errorClass: 'Error' }),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('sk-abc');
  });

  it('fails open when the snapshot read throws', async () => {
    const { inner, runtime } = makeRuntime();
    const evaluate = vi.fn();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate,
        getSnapshot: async () => {
          throw new Error('snapshot failed');
        },
      }),
    );

    await expect(wrapped.chat(chatPayload)).resolves.toBeInstanceOf(Response);
    expect(evaluate).not.toHaveBeenCalled();
    expect(inner.chat).toHaveBeenCalledOnce();
  });

  it('still blocks when record throws after a block decision', async () => {
    const { inner, runtime } = makeRuntime();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({
        evaluate: async () => evaluated('block'),
        record: () => {
          throw new Error('db write failed');
        },
      }),
    );

    await expect(wrapped.chat(chatPayload)).rejects.toBeInstanceOf(ContentModerationBlockedError);
    expect(inner.chat).not.toHaveBeenCalled();
  });

  it('does not evaluate or record when mode is off (snapshot only on the hot path)', async () => {
    const { inner, runtime } = makeRuntime();
    const evaluate = vi.fn();
    const record = vi.fn();
    const dbReads: string[] = [];
    const getSnapshot = vi.fn(async () => {
      dbReads.push('snapshot');
      return snapshot('off');
    });

    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({ evaluate, getSnapshot, record }),
    );

    await wrapped.chat(chatPayload);
    expect(dbReads).toEqual(['snapshot']);
    expect(evaluate).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(inner.chat).toHaveBeenCalledOnce();
  });

  it('forwards embeddings and other methods untouched', async () => {
    const { embeddings, runtime } = makeRuntime();
    const evaluate = vi.fn();
    const wrapped = createModerationAwareRuntime(runtime, ctx, makeDeps({ evaluate }));

    await wrapped.embeddings({ input: 'hi', model: 'text-embedding-3' });
    expect(embeddings).toHaveBeenCalledOnce();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('skips evaluate when extracted text is empty', async () => {
    const { inner, runtime } = makeRuntime();
    const evaluate = vi.fn();
    const wrapped = createModerationAwareRuntime(
      runtime,
      ctx,
      makeDeps({ evaluate, extractPromptText: () => null }),
    );

    await wrapped.chat(chatPayload);
    expect(evaluate).not.toHaveBeenCalled();
    expect(inner.chat).toHaveBeenCalledOnce();
  });
});
