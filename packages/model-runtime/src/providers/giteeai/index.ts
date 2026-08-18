import type { AiModelType } from 'model-bank';
import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { processMultiProviderModelList } from '../../utils/modelParse';

/**
 * Documented GET /v1/models card when `include_details=true`.
 * @see https://ai.gitee.com/v1/yaml
 */
export interface GiteeAIOperation {
  input_million_tokens_price?: number | string;
  name?: string;
  output_million_tokens_price?: number | string;
  path?: string;
  price?: number | string;
  type?: string;
  unit_tag?: { slug?: string } | null;
}

export interface GiteeAIModelCard {
  avatar?: string;
  created?: number;
  description?: string;
  id: string;
  object?: string;
  operations?: GiteeAIOperation[];
  owned_by?: string;
}

// 23-value enum is open; unlisted types (rerank, doc2md, text23d, …) stay undefined.
const GITEE_OPERATION_TYPE_MAP: Record<string, AiModelType> = {
  completions: 'chat',
  embeddings: 'embedding',
  image2image: 'image',
  image2video: 'video',
  speech2text: 'asr',
  text2image: 'image',
  text2music: 'text2music',
  text2speech: 'tts',
  text2text: 'chat',
  text2video: 'video',
};

const giteeTypeFromOperations = (operations?: GiteeAIOperation[]) => {
  if (!operations) return undefined;

  for (const operation of operations) {
    const mapped = operation.type
      ? GITEE_OPERATION_TYPE_MAP[operation.type.toLowerCase()]
      : undefined;
    if (mapped) return mapped;
  }

  return undefined;
};

export const mapGiteeAIModel = (model: GiteeAIModelCard) => ({
  created: model.created,
  description: model.description,
  id: model.id,
  type: giteeTypeFromOperations(model.operations),
});

export const params = {
  baseURL: 'https://ai.gitee.com/v1',
  debug: {
    chatCompletion: () => process.env.DEBUG_GITEE_AI_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list({
      query: { include_details: true },
    })) as any;
    const modelList: GiteeAIModelCard[] = Array.isArray(modelsPage?.data)
      ? modelsPage.data
      : Array.isArray(modelsPage)
        ? modelsPage
        : [];

    return await processMultiProviderModelList(modelList.map(mapGiteeAIModel), 'giteeai');
  },
  provider: ModelProvider.GiteeAI,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeGiteeAI = createOpenAICompatibleRuntime(params);
