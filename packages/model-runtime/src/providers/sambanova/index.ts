import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { processMultiProviderModelList } from '../../utils/modelParse';

export interface SambaNovaModelCard {
  context_length?: number;
  id: string;
  max_completion_tokens?: number;
  pricing?: {
    completion?: number | string;
    prompt?: number | string;
  };
}

/**
 * SambaNova documents pricing as USD per single token.
 * formatPricing expects USD per million tokens, so × 1e6.
 * Drop the unit unless the converted rate is a finite, non-negative number.
 */
const usdPerTokenToPerMillion = (value: number | string | undefined): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  const perMillion = n * 1e6;
  if (!Number.isFinite(perMillion) || perMillion < 0) return undefined;
  return perMillion;
};

const mapSambaNovaModel = (model: SambaNovaModelCard) => {
  const input = usdPerTokenToPerMillion(model.pricing?.prompt);
  const output = usdPerTokenToPerMillion(model.pricing?.completion);

  return {
    contextWindowTokens: model.context_length,
    id: model.id,
    maxOutput: model.max_completion_tokens,
    // No description / displayName / capability booleans on the wire — leave
    // them unset so processModelCard can run keyword + model-bank fallbacks.
    pricing: input !== undefined || output !== undefined ? { input, output } : undefined,
  };
};

export const params = {
  baseURL: 'https://api.sambanova.ai/v1',
  debug: {
    chatCompletion: () => process.env.DEBUG_SAMBANOVA_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as { data?: SambaNovaModelCard[] };
    const modelList = Array.isArray(modelsPage?.data) ? modelsPage.data : [];

    return processMultiProviderModelList(
      modelList.filter((model) => model?.id).map(mapSambaNovaModel),
      'sambanova',
    );
  },
  provider: ModelProvider.SambaNova,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeSambaNovaAI = createOpenAICompatibleRuntime(params);
