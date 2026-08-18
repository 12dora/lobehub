// @vitest-environment node
import type { ModelTokensUsage } from '@lobechat/types';
import type { Pricing } from 'model-bank';
import { describe, expect, it } from 'vitest';

import { computeChatCost } from '../../core/usageConverters/utils/computeChatCost';
import { mapXAIModel } from './mapXAIModel';

// Verbatim examples from https://docs.x.ai/developers/rest-api-reference/inference/models
const documentedXAIModels = [
  {
    aliases: [],
    cached_prompt_text_token_price: 2000,
    completion_text_token_price: 25_000,
    context_length: 131_072,
    created: 1_776_556_800,
    id: 'latest',
    object: 'model',
    owned_by: 'xai',
    prompt_image_token_price: 12_500,
    prompt_text_token_price: 12_500,
  },
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
  {
    aliases: [],
    context_length: 1024,
    created: 1_769_472_000,
    id: 'grok-imagine-image',
    image_price: 200_000_000,
    object: 'model',
    owned_by: 'xai',
  },
];

describe('mapXAIModel', () => {
  it('maps context_length and converts USD-cents-per-100M token prices', () => {
    expect(mapXAIModel(documentedXAIModels[0])).toEqual({
      contextWindowTokens: 131_072,
      created: 1_776_556_800,
      id: 'latest',
      pricing: {
        cachedInput: 0.2,
        input: 1.25,
        output: 2.5,
      },
    });
  });

  it('emits tiered units only when long_context_threshold is greater than 0', () => {
    expect(mapXAIModel(documentedXAIModels[1])).toEqual({
      contextWindowTokens: 256_000,
      created: 1_768_003_200,
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
    });
  });

  it('does not map image_price or invent a pricing unit for image-only cards', () => {
    expect(mapXAIModel(documentedXAIModels[2])).toEqual({
      contextWindowTokens: 1024,
      created: 1_769_472_000,
      id: 'grok-imagine-image',
      pricing: undefined,
    });
  });

  it('charges the long-context rate at or above the documented threshold', () => {
    const mapped = mapXAIModel(documentedXAIModels[1]);
    const pricing = mapped.pricing as Pricing;
    const threshold = 128_000;

    const usageAt = (inputTokens: number): ModelTokensUsage => ({
      inputTextTokens: inputTokens,
      totalInputTokens: inputTokens,
    });

    const inputRate = (inputTokens: number) => {
      const result = computeChatCost(pricing, usageAt(inputTokens));
      return result?.breakdown.find((item) => item.unit.name === 'textInput')?.segments?.[0]?.rate;
    };

    expect(inputRate(threshold - 1)).toBe(2);
    expect(inputRate(threshold)).toBe(4);
    expect(inputRate(threshold + 1)).toBe(4);
  });

  it('does not treat a zero long_context_threshold as a long-context tier', () => {
    expect(
      mapXAIModel({
        cached_prompt_text_token_price: 2000,
        cached_prompt_text_token_price_long_context: 0,
        completion_text_token_price: 25_000,
        completion_text_token_price_long_context: 0,
        context_length: 131_072,
        id: 'latest',
        long_context_threshold: 0,
        prompt_text_token_price: 12_500,
        prompt_text_token_price_long_context: 0,
      }),
    ).toEqual({
      contextWindowTokens: 131_072,
      created: undefined,
      id: 'latest',
      pricing: {
        cachedInput: 0.2,
        input: 1.25,
        output: 2.5,
      },
    });
  });

  it('does not read modality or description fields that /v1/models does not document', () => {
    const mapped = mapXAIModel({
      context_length: 131_072,
      description: 'invented',
      id: 'custom-xai-model',
      input_modalities: ['text', 'image'],
      name: 'Custom XAI',
      output_modalities: ['text', 'image', 'video'],
    } as never);

    expect(mapped).toEqual({
      contextWindowTokens: 131_072,
      created: undefined,
      id: 'custom-xai-model',
      pricing: undefined,
    });
    expect(mapped).not.toHaveProperty('description');
    expect(mapped).not.toHaveProperty('displayName');
    expect(mapped).not.toHaveProperty('imageOutput');
    expect(mapped).not.toHaveProperty('video');
    expect(mapped).not.toHaveProperty('vision');
  });
});
