import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { processMultiProviderModelList } from '../../utils/modelParse';
import { createHunyuanImage } from './createImage';
import { createHunyuanVideo } from './createVideo';

/**
 * Documented TokenHub GET /v1/models card.
 * `owned_by` is not in the field table or the official example.
 * @see https://cloud.tencent.com/document/product/1823/130078
 */
export interface HunyuanModelCard {
  created?: number;
  id: string;
  name?: string;
  object?: string;
  status?: string;
}

export const mapHunyuanModel = (model: HunyuanModelCard) => ({
  created: model.created,
  displayName: model.name,
  id: model.id,
});

export const params = {
  baseURL: 'https://tokenhub.tencentmaas.com/v1',
  chatCompletion: {
    handlePayload: (payload) => {
      const { enabledSearch, model, thinking, ...rest } = payload;

      // Transform reasoning object to reasoning_content string for multi-turn conversations
      const messages = payload.messages.map((message: any) => {
        const { reasoning, ...rest } = message;

        const reasoningContent =
          typeof rest.reasoning_content === 'string'
            ? rest.reasoning_content
            : typeof reasoning?.content === 'string'
              ? reasoning.content
              : undefined;

        if (message.role === 'assistant' && model === 'hy3-preview') {
          return {
            ...rest,
            reasoning_content: reasoningContent ?? '',
          };
        }

        if (reasoningContent !== undefined) {
          return {
            ...rest,
            reasoning_content: reasoningContent,
          };
        }

        return rest;
      });

      return {
        ...rest,
        frequency_penalty: undefined,
        stream: rest.stream ?? true,
        thinking: thinking ? { type: thinking.type } : undefined,
        messages,
        model,
        presence_penalty: undefined,
        ...(enabledSearch && {
          citation: true,
          enable_enhancement: true,
          /*
          enable_multimedia: true,
          */
          enable_speed_search: process.env.HUNYUAN_ENABLE_SPEED_SEARCH === '1',
          search_info: true,
        }),
      } as any;
    },
  },
  createImage: createHunyuanImage,
  createVideo: createHunyuanVideo,
  handlePollVideoStatus: async (inferenceId, options) => {
    const { pollHunyuanVideoStatus } = await import('./createVideo');
    return pollHunyuanVideoStatus(inferenceId, options.apiKey || '', options.baseURL || '');
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_HUNYUAN_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as any;
    const modelList: HunyuanModelCard[] = Array.isArray(modelsPage?.data) ? modelsPage.data : [];

    return processMultiProviderModelList(modelList.map(mapHunyuanModel), 'hunyuan');
  },
  provider: ModelProvider.Hunyuan,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeHunyuanAI = createOpenAICompatibleRuntime(params);
