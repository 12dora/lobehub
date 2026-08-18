import type { ChatModelCard } from '@lobechat/types';
import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { resolveParameters } from '../../core/parameterResolver';

export type CohereCompatibleEndpoint =
  'chat' | 'classify' | 'embed' | 'generate' | 'rate' | 'rerank' | 'summarize';

export interface CohereModelCard {
  context_length?: number;
  endpoints?: CohereCompatibleEndpoint[];
  features?: string[] | null;
  name: string;
  supports_vision?: boolean;
}

const cohereTypeFromEndpoints = (
  endpoints: CohereCompatibleEndpoint[] | undefined,
): ChatModelCard['type'] => {
  if (!endpoints?.length) return undefined;
  if (endpoints.includes('chat')) return 'chat';
  if (endpoints.includes('embed')) return 'embedding';
  return undefined;
};

export const params = {
  baseURL: 'https://api.cohere.ai/compatibility/v1',
  chatCompletion: {
    // https://docs.cohere.com/v2/docs/compatibility-api#unsupported-parameters
    excludeUsage: true,
    handlePayload: (payload) => {
      const { frequency_penalty, presence_penalty, top_p, ...rest } = payload;

      // Resolve parameters with range constraints
      const resolvedParams = resolveParameters(
        { frequency_penalty, presence_penalty, top_p },
        {
          frequencyPenaltyRange: { max: 1, min: 0 },
          normalizeTemperature: false,
          presencePenaltyRange: { max: 1, min: 0 },
          topPRange: { max: 1, min: 0 },
        },
      );

      return {
        ...rest,
        ...resolvedParams,
      } as any;
    },
    noUserId: true,
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_COHERE_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const { LOBE_DEFAULT_MODEL_LIST } = await import('model-bank');

    client.baseURL = 'https://api.cohere.com/v1';

    const modelList: CohereModelCard[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    do {
      const modelsPage = (await client.models.list({
        query: {
          page_size: 1000,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      })) as any;
      const pageModels: CohereModelCard[] = modelsPage.body?.models ?? [];
      modelList.push(...pageModels);
      pageToken =
        typeof modelsPage.body?.next_page_token === 'string' && modelsPage.body.next_page_token
          ? modelsPage.body.next_page_token
          : undefined;
      pages += 1;
    } while (pageToken && pages < 20);

    return modelList
      .map((model) => {
        const knownModel = LOBE_DEFAULT_MODEL_LIST.find(
          (m) => model.name.toLowerCase() === m.id.toLowerCase(),
        );

        return {
          contextWindowTokens: model.context_length,
          displayName: knownModel?.displayName ?? undefined,
          enabled: knownModel?.enabled || false,
          functionCall:
            model.features?.includes('tools') === true ? true : knownModel?.abilities?.functionCall,
          id: model.name,
          type: cohereTypeFromEndpoints(model.endpoints),
          vision: model.supports_vision === true ? true : knownModel?.abilities?.vision,
        };
      })
      .filter(Boolean) as ChatModelCard[];
  },
  provider: ModelProvider.Cohere,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeCohereAI = createOpenAICompatibleRuntime(params);
