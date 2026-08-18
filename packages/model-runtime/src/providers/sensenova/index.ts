import type { ChatModelCard } from '@lobechat/types';
import { LOBE_DEFAULT_MODEL_LIST, ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';

export interface SenseNovaModelCard {
  context_length?: number;
  created?: number;
  description?: string;
  id: string;
  input_modalities?: string[];
  max_output_length?: number;
  name?: string;
  openrouter?: { slug?: string };
  output_modalities?: string[];
  // Sub-keys, currency and unit are undocumented (USD/token vs CNY/1k). Do not map.
  pricing?: {
    completion?: string;
    image?: string;
    input_cache_read?: string;
    prompt?: string;
    request?: string;
  };
  supported_features?: string[];
}

/** Present array is authoritative; an omitted container must not become `false`. */
const fromList = (list: string[] | undefined, value: string): boolean | undefined =>
  Array.isArray(list) ? list.includes(value) : undefined;

export const mapSenseNovaModel = (
  model: SenseNovaModelCard,
  knownModel?: (typeof LOBE_DEFAULT_MODEL_LIST)[number],
) => ({
  contextWindowTokens: model.context_length ?? knownModel?.contextWindowTokens ?? undefined,
  description: model.description ?? knownModel?.description ?? undefined,
  displayName: model.name ?? knownModel?.displayName ?? undefined,
  enabled: knownModel?.enabled || false,
  functionCall: fromList(model.supported_features, 'tools') ?? knownModel?.abilities?.functionCall,
  id: model.id,
  imageOutput: fromList(model.output_modalities, 'image') ?? knownModel?.abilities?.imageOutput,
  maxOutput: model.max_output_length ?? knownModel?.maxOutput ?? undefined,
  releasedAt: model.created ? new Date(model.created * 1000).toISOString() : undefined,
  reasoning: fromList(model.supported_features, 'reasoning') ?? knownModel?.abilities?.reasoning,
  structuredOutput:
    fromList(model.supported_features, 'json_mode') ?? knownModel?.abilities?.structuredOutput,
  vision: fromList(model.input_modalities, 'image') ?? knownModel?.abilities?.vision,
});

export const params = {
  baseURL: 'https://token.sensenova.cn/v1',
  chatCompletion: {
    handlePayload: (payload) => {
      const { frequency_penalty, presence_penalty, temperature, top_p, ...rest } = payload;

      return {
        ...rest,
        frequency_penalty:
          frequency_penalty !== undefined && frequency_penalty > 0 && frequency_penalty <= 2
            ? frequency_penalty
            : undefined,
        presence_penalty:
          presence_penalty !== undefined && presence_penalty > 0 && presence_penalty <= 2
            ? presence_penalty
            : undefined,
        temperature:
          temperature !== undefined && temperature > 0 && temperature <= 2
            ? temperature
            : undefined,
        top_p: top_p !== undefined && top_p > 0 && top_p < 1 ? top_p : undefined,
      } as any;
    },
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_SENSENOVA_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as any;
    const modelList: SenseNovaModelCard[] = modelsPage.data;

    return modelList
      .map((model) => {
        const knownModel = LOBE_DEFAULT_MODEL_LIST.find(
          (m) => model.id.toLowerCase() === m.id.toLowerCase(),
        );

        return mapSenseNovaModel(model, knownModel);
      })
      .filter(Boolean) as ChatModelCard[];
  },
  provider: ModelProvider.SenseNova,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeSenseNovaAI = createOpenAICompatibleRuntime(params);
