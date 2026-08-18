import type { AiModelType } from 'model-bank';
import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { processMultiProviderModelList } from '../../utils/modelParse';

/**
 * Documented GET /maas/v1/models card. All seven fields are required.
 * @see https://docs.infini-ai.com/openapi/maas-v1.openapi.yaml
 */
export interface InfiniAIModelCard {
  context_length: number;
  created: number;
  id: string;
  max_output_length: number;
  model_type: string;
  object: string;
  owned_by: string;
}

// Spec enum is open ("等类型"). 重排序模型 / 多模态模型 have no counterpart.
const INFINIAI_TYPE_MAP: Record<string, AiModelType> = {
  大语言模型: 'chat',
  向量模型: 'embedding',
  生图大模型: 'image',
  视频大模型: 'video',
};

// 0 means the limit is inapplicable or unpublished.
const infiniaiLength = (value?: number) =>
  typeof value === 'number' && value > 0 ? value : undefined;

export const mapInfiniAIModel = (model: InfiniAIModelCard) => ({
  contextWindowTokens: infiniaiLength(model.context_length),
  created: model.created,
  id: model.id,
  maxOutput: infiniaiLength(model.max_output_length),
  type: INFINIAI_TYPE_MAP[model.model_type],
});

export const params = {
  baseURL: 'https://cloud.infini-ai.com/maas/v1',
  chatCompletion: {
    handlePayload: (payload) => {
      const { model, thinking, ...rest } = payload;

      return {
        ...rest,
        enable_thinking: thinking !== undefined ? thinking.type === 'enabled' : false,
        model,
      } as any;
    },
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_INFINIAI_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as any;
    const modelList: InfiniAIModelCard[] = modelsPage.data ?? [];

    return processMultiProviderModelList(modelList.map(mapInfiniAIModel), 'infiniai');
  },
  provider: ModelProvider.InfiniAI,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeInfiniAI = createOpenAICompatibleRuntime(params);
