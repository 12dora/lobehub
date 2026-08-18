import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { processMultiProviderModelList } from '../../utils/modelParse';

export interface AkashChatModelCard {
  id: string;
}

export const params = {
  baseURL: 'https://api.akashml.com/v1',
  chatCompletion: {
    handlePayload: (payload) => {
      const { model, reasoning, reasoning_effort, thinking, ...rest } = payload;

      // AkashML documents a first-class `reasoning` object (effort / enabled /
      // max_tokens). The old LiteLLM fields and the DeepSeek-V3-1 allowlist
      // are gone with the chatapi.akash.network gateway.
      const finalReasoning = {
        ...reasoning,
        ...(reasoning_effort && { effort: reasoning_effort }),
        ...(thinking?.budget_tokens && { max_tokens: thinking.budget_tokens }),
        ...(thinking?.type === 'enabled' && { enabled: true }),
        ...(thinking?.type === 'disabled' && { enabled: false }),
      };

      return {
        ...rest,
        model,
        ...(Object.keys(finalReasoning).length > 0 && { reasoning: finalReasoning }),
      } as any;
    },
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_AKASH_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as any;
    const rawList: any[] = modelsPage.data || [];

    // Remove `created` field from each model item

    const modelList: AkashChatModelCard[] = rawList.map(({ created: _, ...rest }) => rest);

    return await processMultiProviderModelList(modelList, 'akashchat');
  },
  provider: ModelProvider.AkashChat,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeAkashChatAI = createOpenAICompatibleRuntime(params);
