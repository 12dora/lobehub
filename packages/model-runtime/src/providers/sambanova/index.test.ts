// @vitest-environment node
import type { PricingUnit } from 'model-bank';
import { ModelProvider } from 'model-bank';
import { describe, expect, it, vi } from 'vitest';

import { testProvider } from '../../providerTestUtils';
import { LobeSambaNovaAI, params } from './index';

const provider = ModelProvider.SambaNova;
const defaultBaseURL = 'https://api.sambanova.ai/v1';

testProvider({
  Runtime: LobeSambaNovaAI,
  provider,
  defaultBaseURL,
  chatDebugEnv: 'DEBUG_SAMBANOVA_CHAT_COMPLETION',
  chatModel: 'Meta-Llama-3.1-8B-Instruct',
  test: {
    skipAPICall: true,
  },
});

/** `rate` lives on the fixed-strategy member only; narrowing keeps the assertion honest. */
const fixedRate = (units: PricingUnit[] | undefined, name: string): number | undefined => {
  const unit = units?.find((item) => item.name === name);
  return unit && unit.strategy === 'fixed' ? unit.rate : undefined;
};

describe('LobeSambaNovaAI - models mapping', () => {
  it('should map documented wire fields and convert per-token USD strings', async () => {
    // Live cross-check from R3 §2.2: Meta-Llama-3.3-70B-Instruct prices are
    // decimal strings at USD per token → $0.60 / $1.20 per 1M.
    const mockClient = {
      models: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              context_length: 131_072,
              id: 'Meta-Llama-3.3-70B-Instruct',
              max_completion_tokens: 8192,
              object: 'model',
              owned_by: 'sambanova',
              pricing: {
                completion: '0.00000120',
                prompt: '0.00000060',
              },
              sn_metadata: {},
            },
          ],
        }),
      },
    };

    const models = await params.models!({ client: mockClient as any });
    const model = models.find((m) => m.id === 'Meta-Llama-3.3-70B-Instruct');

    expect(mockClient.models.list).toHaveBeenCalledTimes(1);
    expect(model).toMatchObject({
      contextWindowTokens: 131_072,
      id: 'Meta-Llama-3.3-70B-Instruct',
      maxOutput: 8192,
    });

    const input = fixedRate(model?.pricing?.units, 'textInput');
    const output = fixedRate(model?.pricing?.units, 'textOutput');
    expect(input).toBeCloseTo(0.6);
    expect(output).toBeCloseTo(1.2);
    expect(model?.releasedAt).toBeUndefined();
  });

  it('should not invent capability booleans when the wire omits them', async () => {
    const mockClient = {
      models: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              context_length: 8192,
              id: 'plain-sambanova-id',
              max_completion_tokens: 1024,
              pricing: { completion: '0.00000120', prompt: '0.00000060' },
            },
          ],
        }),
      },
    };

    const models = await params.models!({ client: mockClient as any });
    const model = models.find((m) => m.id === 'plain-sambanova-id');

    expect(model?.displayName).toBe('plain-sambanova-id');
    // processModelCard keyword fallback may still run; we only assert we did
    // not force a wire-sourced true without a boolean on the payload.
    expect(model).not.toHaveProperty('functionCall', true);
    expect(model).not.toMatchObject({ vision: true });
  });

  it('should drop blank, negative and overflowing price strings', async () => {
    const mockClient = {
      models: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'blank-and-negative',
              pricing: { completion: '-0.000001', prompt: ' ' },
            },
            {
              id: 'overflow-price',
              pricing: { completion: '1e308', prompt: '1e308' },
            },
          ],
        }),
      },
    };

    const models = await params.models!({ client: mockClient as any });
    const blank = models.find((m) => m.id === 'blank-and-negative');
    const overflow = models.find((m) => m.id === 'overflow-price');

    expect(blank?.pricing).toBeUndefined();
    expect(overflow?.pricing).toBeUndefined();
    expect(fixedRate(blank?.pricing?.units, 'textInput')).toBeUndefined();
    expect(fixedRate(blank?.pricing?.units, 'textOutput')).toBeUndefined();
    expect(fixedRate(overflow?.pricing?.units, 'textInput')).toBeUndefined();
    expect(fixedRate(overflow?.pricing?.units, 'textOutput')).toBeUndefined();
  });
});
