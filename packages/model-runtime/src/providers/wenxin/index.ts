import type { AiModelType } from 'model-bank';
import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { processMultiProviderModelList } from '../../utils/modelParse';
import { createWenxinImage } from './createImage';
import { createWenxinVideo } from './createVideo';

/**
 * Documented GET /v2/models card.
 * @see https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y
 */
export interface WenxinModelArchitecture {
  input_modalities?: string[];
  modality?: string;
  output_modalities?: string[];
}

export interface WenxinModelPricing {
  completion?: string | Array<{ price: string; up_to: number | null }> | null;
  image?: string | null;
  prompt?: string | Array<{ price: string; up_to: number | null }>;
  video?: string | null;
  web_search?: string | null;
}

export interface WenxinModelCard {
  architecture?: WenxinModelArchitecture;
  context_length?: number | null;
  created?: number;
  id: string;
  max_completions_tokens?: number | null;
  max_tokens?: number | null;
  object?: string;
  owned_by?: string;
  pricing?: WenxinModelPricing;
  prompt_tokens?: number | null;
  type?: string;
}

// Doc enum is open ("例如 … 等"). Unlisted values stay undefined.
const WENXIN_TYPE_MAP: Record<string, AiModelType> = {
  chat: 'chat',
  embeddings: 'embedding',
  image2image: 'image',
  text2image: 'image',
  text2video: 'video',
};

const wenxinTokenCount = (value: number | null | undefined) =>
  typeof value === 'number' ? value : undefined;

const wenxinHasModality = (modalities: string[] | undefined, value: string) =>
  modalities?.includes(value) === true ? true : undefined;

export const mapWenxinModel = (model: WenxinModelCard) => ({
  contextWindowTokens: wenxinTokenCount(model.context_length),
  created: model.created,
  id: model.id,
  imageOutput: wenxinHasModality(model.architecture?.output_modalities, 'image'),
  maxOutput: wenxinTokenCount(model.max_tokens),
  type: model.type ? WENXIN_TYPE_MAP[model.type.toLowerCase()] : undefined,
  vision: wenxinHasModality(model.architecture?.input_modalities, 'image'),
});

export const params = {
  baseURL: 'https://qianfan.baidubce.com/v2',
  chatCompletion: {
    handlePayload: (payload) => {
      const { enabledSearch, thinking, ...rest } = payload;

      return {
        ...rest,
        stream: true,
        ...(enabledSearch && {
          web_search: {
            enable: true,
            enable_citation: true,
            enable_trace: true,
          },
        }),
        ...(thinking && {
          enable_thinking: thinking.type ? thinking.type !== 'disabled' : undefined,
          ...(thinking.budget_tokens !== undefined &&
            thinking.budget_tokens !== 0 && {
              thinking_budget: Math.min(Math.max(thinking.budget_tokens, 100), 16_384),
            }),
        }),
      } as any;
    },
  },
  createImage: createWenxinImage,
  createVideo: createWenxinVideo,
  handlePollVideoStatus: async (inferenceId, options) => {
    const { pollWenxinVideoStatus } = await import('./createVideo');
    return pollWenxinVideoStatus(inferenceId, {
      apiKey: options.apiKey,
      baseURL: (options.baseURL || '').replace('/v2', ''),
    });
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_WENXIN_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as any;
    const modelList: WenxinModelCard[] = modelsPage.data ?? [];

    return processMultiProviderModelList(modelList.map(mapWenxinModel), 'wenxin');
  },
  provider: ModelProvider.Wenxin,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeWenxinAI = createOpenAICompatibleRuntime(params);
