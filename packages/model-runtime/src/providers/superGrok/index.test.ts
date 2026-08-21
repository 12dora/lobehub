// @vitest-environment node
import { ModelProvider } from 'model-bank';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    expect(models.map((model) => model.id).sort()).toEqual(['grok-4.5', 'grok-4.6']);
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

    expect(models).toEqual([
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
    ]);
    expect(models[0]).not.toHaveProperty('aliases');
    expect(models[0]).not.toHaveProperty('owned_by');
  });

  it('leaves abilities to keyword fallback when the list card has only an id', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: [{ id: 'grok-keyword-only-test-model' }],
    } as never);

    const models = await instance.models();

    expect(models).toEqual([
      expect.objectContaining({
        functionCall: true,
        id: 'grok-keyword-only-test-model',
        reasoning: false,
        search: true,
        vision: false,
      }),
    ]);
  });

  it('treats an explicit empty list as zero models', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({ data: [] } as never);

    await expect(instance.models()).resolves.toEqual([]);
  });

  it.each([
    { data: undefined, label: 'missing data' },
    { data: { error: { code: 'invalid_token' } }, label: 'a non-array data field' },
  ])('throws when the list answers with $label', async ({ data }) => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({ data } as never);

    await expect(instance.models()).rejects.toThrow('SuperGrok models payload was not a list');
  });
});
