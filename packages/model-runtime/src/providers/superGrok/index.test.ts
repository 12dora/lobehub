// @vitest-environment node
import { ModelProvider } from 'model-bank';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testProvider } from '../../providerTestUtils';
import { LobeSuperGrokAI } from './index';

vi.mock('@lobechat/business-model-bank/model-config', () => ({
  loadModels: vi.fn().mockResolvedValue([]),
}));

testProvider({
  Runtime: LobeSuperGrokAI,
  provider: ModelProvider.SuperGrok,
  defaultBaseURL: 'https://api.x.ai/v1',
  chatDebugEnv: 'DEBUG_SUPERGROK_CHAT_COMPLETION',
  responseDebugEnv: 'DEBUG_SUPERGROK_RESPONSES',
  chatModel: 'grok-4.6',
  test: { useResponsesAPI: true },
});

describe('LobeSuperGrokAI - responses payload', () => {
  let instance: InstanceType<typeof LobeSuperGrokAI>;

  beforeEach(() => {
    instance = new LobeSuperGrokAI({ apiKey: 'test_api_key' });
    vi.spyOn(instance['client'].chat.completions, 'create').mockResolvedValue(
      new ReadableStream() as never,
    );
    vi.spyOn(instance['client'].responses, 'create').mockResolvedValue(
      new ReadableStream() as never,
    );
  });

  it('adds web_search and x_search tools when enabledSearch is true', async () => {
    await instance.chat({
      enabledSearch: true,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'grok-4.6',
      tools: [{ function: { description: 'test', name: 'test' }, type: 'function' as const }],
    });

    const createCall = (instance['client'].responses.create as Mock).mock.calls[0][0];
    expect(createCall.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function', name: 'test' }),
        { type: 'web_search' },
        { type: 'x_search' },
      ]),
    );
  });

  it('does not add native search tools when enabledSearch is false', async () => {
    await instance.chat({
      enabledSearch: false,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'grok-4.6',
      tools: [{ function: { description: 'test', name: 'test' }, type: 'function' as const }],
    });

    const createCall = (instance['client'].responses.create as Mock).mock.calls[0][0];
    expect(createCall.tools).not.toContainEqual({ type: 'web_search' });
    expect(createCall.tools).not.toContainEqual({ type: 'x_search' });
  });
});

describe('LobeSuperGrokAI - models', () => {
  let instance: InstanceType<typeof LobeSuperGrokAI>;

  beforeEach(() => {
    instance = new LobeSuperGrokAI({ apiKey: 'test_api_key' });
  });

  it('still processes { id }-only list items via the xai keyword config and catalog', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: [{ id: 'grok-4.6' }, { id: 'grok-4.5' }],
    } as never);

    const models = await instance.models();

    expect(instance['client'].models.list).toHaveBeenCalled();
    expect(
      models
        .filter((model) => model.type === 'chat')
        .map((model) => model.id)
        .sort(),
    ).toEqual(['grok-4.5', 'grok-4.6']);
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contextWindowTokens: 500_000,
          displayName: 'Grok 4.5',
          functionCall: true,
          id: 'grok-4.5',
          reasoning: true,
          vision: true,
        }),
        expect.objectContaining({
          contextWindowTokens: 500_000,
          displayName: 'Grok 4.6',
          functionCall: true,
          id: 'grok-4.6',
          reasoning: true,
          vision: true,
        }),
        expect.objectContaining({ id: 'grok-imagine-image', type: 'image' }),
        expect.objectContaining({ id: 'grok-imagine-image-quality', type: 'image' }),
        expect.objectContaining({ id: 'grok-imagine-video', type: 'video' }),
      ]),
    );
  });

  it('maps documented /v1/models fields and leaves abilities to keyword fallback', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: [
        {
          aliases: [],
          cached_prompt_text_token_price: 2000,
          completion_text_token_price: 80_000,
          completion_text_token_price_long_context: 160_000,
          context_length: 256_000,
          created: 1_768_003_200,
          id: 'grok-420-reasoning',
          long_context_threshold: 128_000,
          object: 'model',
          owned_by: 'xai',
          prompt_image_token_price: 0,
          prompt_text_token_price: 20_000,
          prompt_text_token_price_long_context: 40_000,
        },
      ],
    } as never);

    const models = await instance.models();
    const live = models.find((model) => model.id === 'grok-420-reasoning');

    expect(live).toEqual(
      expect.objectContaining({
        contextWindowTokens: 256_000,
        functionCall: true,
        id: 'grok-420-reasoning',
        pricing: {
          units: [
            {
              name: 'textInput',
              strategy: 'tiered',
              tiers: [
                { rate: 2, upTo: 127_999 },
                { rate: 4, upTo: 'infinity' },
              ],
              unit: 'millionTokens',
            },
            {
              name: 'textOutput',
              strategy: 'tiered',
              tiers: [
                { rate: 8, upTo: 127_999 },
                { rate: 16, upTo: 'infinity' },
              ],
              unit: 'millionTokens',
            },
            {
              name: 'textInput_cacheRead',
              strategy: 'tiered',
              tiers: [
                { rate: 0.2, upTo: 127_999 },
                { rate: 0.2, upTo: 'infinity' },
              ],
              unit: 'millionTokens',
            },
          ],
        },
        reasoning: true,
        releasedAt: '2026-01-10',
        search: true,
        vision: true,
      }),
    );
    expect(live).not.toHaveProperty('aliases');
    expect(live).not.toHaveProperty('owned_by');
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'grok-imagine-image', type: 'image' }),
        expect.objectContaining({ id: 'grok-imagine-video', type: 'video' }),
      ]),
    );
  });

  it('leaves abilities to keyword fallback when the list card has only an id', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: [{ id: 'grok-keyword-only-test-model' }],
    } as never);

    const models = await instance.models();

    expect(models.find((model) => model.id === 'grok-keyword-only-test-model')).toEqual(
      expect.objectContaining({
        functionCall: true,
        id: 'grok-keyword-only-test-model',
        reasoning: false,
        search: true,
        vision: false,
      }),
    );
  });

  it('still unions static image and video cards when the live list is empty', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({ data: [] } as never);

    const models = await instance.models();

    expect(models.map((model) => model.id).sort()).toEqual([
      'grok-imagine-image',
      'grok-imagine-image-quality',
      'grok-imagine-video',
    ]);
  });

  it('does not duplicate generation cards already present in the live list', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: [{ id: 'grok-4.6' }, { id: 'grok-imagine-image' }],
    } as never);

    const models = await instance.models();

    expect(models.filter((model) => model.id === 'grok-imagine-image')).toHaveLength(1);
    expect(models.find((model) => model.id === 'grok-imagine-image')).toEqual(
      expect.objectContaining({
        id: 'grok-imagine-image',
        parameters: expect.objectContaining({
          imageUrls: { default: [] },
          prompt: { default: '' },
        }),
        type: 'image',
      }),
    );
  });

  it.each([
    { data: undefined, label: 'missing data' },
    { data: { error: { code: 'invalid_token' } }, label: 'a non-array data field' },
  ])('throws when the list answers with $label', async ({ data }) => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({ data } as never);

    await expect(instance.models()).rejects.toThrow('SuperGrok models payload was not a list');
  });
});

describe('LobeSuperGrokAI - image and video', () => {
  let instance: InstanceType<typeof LobeSuperGrokAI>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    instance = new LobeSuperGrokAI({ apiKey: 'test_api_key' });
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts image generations to api.x.ai with the injected bearer token', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [{ revised_prompt: 'a cat', url: 'https://cdn.example/out.png' }],
      }),
      ok: true,
    });

    const result = await instance.createImage({
      model: 'grok-imagine-image',
      params: { prompt: 'a cat' },
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.x.ai/v1/images/generations',
      expect.objectContaining({
        headers: {
          'Authorization': 'Bearer test_api_key',
          'Content-Type': 'application/json',
        },
        method: 'POST',
      }),
    );
    expect(result).toEqual({ imageUrl: 'https://cdn.example/out.png' });
  });

  it('passes a data URI through to image_url on edits', async () => {
    const dataUri = 'data:image/png;base64,aaaa';
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [{ revised_prompt: 'edit', url: 'https://cdn.example/edited.png' }],
      }),
      ok: true,
    });

    await instance.createImage({
      model: 'grok-imagine-image',
      params: { imageUrls: [dataUri], prompt: 'make it night' },
    });

    const body = JSON.parse((global.fetch as Mock).mock.calls[0][1].body);
    expect(body).toEqual({
      images: [{ type: 'image_url', url: dataUri }],
      model: 'grok-imagine-image',
      prompt: 'make it night',
    });
  });

  it('posts video generations to api.x.ai with the injected bearer token', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ request_id: 'xai-request-123' }),
      ok: true,
    });

    const result = await instance.createVideo({
      model: 'grok-imagine-video',
      params: { prompt: 'a cyberpunk city' },
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.x.ai/v1/videos/generations',
      expect.objectContaining({
        headers: {
          'Authorization': 'Bearer test_api_key',
          'Content-Type': 'application/json',
        },
        method: 'POST',
      }),
    );
    expect(result).toEqual({ inferenceId: 'xai-request-123' });
  });

  it('polls video status on the xAI videos API', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ status: 'done', video: { url: 'https://cdn.example/v.mp4' } }),
      ok: true,
    });

    const result = await instance.handlePollVideoStatus('req-1');

    expect(fetch).toHaveBeenCalledWith(
      'https://api.x.ai/v1/videos/req-1',
      expect.objectContaining({
        headers: {
          'Authorization': 'Bearer test_api_key',
          'Content-Type': 'application/json',
        },
        method: 'GET',
      }),
    );
    expect(result).toEqual({ status: 'success', videoUrl: 'https://cdn.example/v.mp4' });
  });
});
