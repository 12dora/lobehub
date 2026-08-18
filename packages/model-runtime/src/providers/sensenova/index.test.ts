// @vitest-environment node
import { ModelProvider } from 'model-bank';
import { describe, expect, it, vi } from 'vitest';

import { testProvider } from '../../providerTestUtils';
import { LobeSenseNovaAI, mapSenseNovaModel, params } from './index';

testProvider({
  Runtime: LobeSenseNovaAI,
  provider: ModelProvider.SenseNova,
  defaultBaseURL: 'https://token.sensenova.cn/v1',
  chatDebugEnv: 'DEBUG_SENSENOVA_CHAT_COMPLETION',
  chatModel: 'SenseNova-V6-5',
  test: {
    skipAPICall: true,
    skipErrorHandle: true,
  },
});

// Wire shape from platform.sensenova.cn docs #list-models
const documentedSenseNovaModel = {
  context_length: 128_000,
  created: 1_730_000_000,
  description: 'SenseNova V6.5',
  id: 'SenseNova-V6-5',
  input_modalities: ['text', 'image'],
  max_output_length: 8192,
  name: 'SenseNova-V6-5',
  openrouter: { slug: 'sensenova/sensenova-6.8-flash-lite' },
  output_modalities: ['text', 'image'],
  pricing: {
    completion: '0',
    image: '0',
    input_cache_read: '0',
    prompt: '0',
    request: '0',
  },
  supported_features: ['tools', 'json_mode', 'reasoning'],
};

describe('mapSenseNovaModel', () => {
  it('maps documented description and output image modality, and does not map pricing', () => {
    expect(mapSenseNovaModel(documentedSenseNovaModel)).toEqual({
      contextWindowTokens: 128_000,
      description: 'SenseNova V6.5',
      displayName: 'SenseNova-V6-5',
      enabled: false,
      functionCall: true,
      id: 'SenseNova-V6-5',
      imageOutput: true,
      maxOutput: 8192,
      reasoning: true,
      releasedAt: new Date(1_730_000_000 * 1000).toISOString(),
      structuredOutput: true,
      vision: true,
    });
  });

  it('does not derive video from the closed output-modality enum', () => {
    const mapped = mapSenseNovaModel({
      ...documentedSenseNovaModel,
      input_modalities: ['text'],
      output_modalities: ['text'],
      supported_features: [],
    });

    expect(mapped.imageOutput).toBe(false);
    expect(mapped.vision).toBe(false);
    expect(mapped).not.toHaveProperty('video');
    expect(mapped).not.toHaveProperty('pricing');
  });
});

describe('LobeSenseNovaAI models', () => {
  it('returns mapped cards without a pricing object', async () => {
    const mockClient = {
      models: {
        list: vi.fn().mockResolvedValue({ data: [documentedSenseNovaModel] }),
      },
    } as any;

    const models = await params.models!({ client: mockClient });

    expect(models).toHaveLength(1);
    expect(models[0].description).toBe('SenseNova V6.5');
    expect(models[0].imageOutput).toBe(true);
    expect(models[0]).not.toHaveProperty('pricing');
  });
});
