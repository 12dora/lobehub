// @vitest-environment node
import { ModelProvider } from 'model-bank';
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

  it('maps context window, name, and modalities from the xAI list', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: [
        {
          aliases: ['custom-latest'],
          description: 'A live SuperGrok listing',
          id: 'custom-xai-model',
          input_modalities: ['text', 'image'],
          max_prompt_length: 131_072,
          name: 'Custom XAI',
          output_modalities: ['text', 'image'],
        },
      ],
    } as never);

    const models = await instance.models();

    expect(models).toEqual([
      expect.objectContaining({
        contextWindowTokens: 131_072,
        description: 'A live SuperGrok listing',
        displayName: 'Custom XAI',
        id: 'custom-xai-model',
        imageOutput: true,
        video: false,
        vision: true,
      }),
    ]);
  });

  it('leaves vision to keyword fallback when modalities are absent', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: [{ id: 'grok-keyword-only-test-model' }],
    } as never);

    const models = await instance.models();

    expect(models).toEqual([
      expect.objectContaining({
        functionCall: true,
        id: 'grok-keyword-only-test-model',
        reasoning: false,
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
