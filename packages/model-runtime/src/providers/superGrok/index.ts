import { ModelProvider } from 'model-bank';

import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { MODEL_LIST_CONFIGS, processModelList } from '../../utils/modelParse';
import { handleXAIChatCompletionPayload, handleXAIResponsesPayload } from '../xai';

/**
 * Fields the xAI list endpoint documents beyond `{ id }`. Aliases are on the
 * wire but ChatModelCard has nowhere to persist them, so they are not mapped.
 */
interface SuperGrokModelCard {
  aliases?: string[];
  context_window?: number;
  contextWindowTokens?: number;
  created?: number;
  description?: string;
  displayName?: string;
  id: string;
  input_modalities?: string[];
  max_prompt_length?: number;
  name?: string;
  output_modalities?: string[];
}

const mapSuperGrokModel = (model: SuperGrokModelCard) => {
  const inputModalities = Array.isArray(model.input_modalities)
    ? model.input_modalities
    : undefined;
  const outputModalities = Array.isArray(model.output_modalities)
    ? model.output_modalities
    : undefined;

  return {
    ...model,
    contextWindowTokens:
      model.contextWindowTokens ?? model.context_window ?? model.max_prompt_length,
    description: model.description,
    displayName: model.displayName ?? model.name,
    imageOutput: outputModalities ? outputModalities.includes('image') : undefined,
    video: outputModalities ? outputModalities.includes('video') : undefined,
    vision: inputModalities ? inputModalities.includes('image') : undefined,
  };
};

/**
 * SuperGrok / X Premium subscription access to Grok models.
 *
 * Talks to the exact same OpenAI-compatible `https://api.x.ai/v1` endpoint as
 * the `xai` provider (payload handling is shared), but authenticates with an
 * OAuth access token instead of an API key. The token is refreshed and
 * injected server-side (see `apps/server` oauthDeviceFlow refresh service) —
 * this runtime stays a stateless bearer client, receiving the fresh token as
 * `apiKey`.
 *
 * Chat only: image/video generation is not exposed through the subscription
 * OAuth scope.
 */
export const LobeSuperGrokAI = createOpenAICompatibleRuntime({
  baseURL: 'https://api.x.ai/v1',
  chatCompletion: {
    handlePayload: handleXAIChatCompletionPayload,
    useResponse: true,
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_SUPERGROK_CHAT_COMPLETION === '1',
    responses: () => process.env.DEBUG_SUPERGROK_RESPONSES === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as { data?: SuperGrokModelCard[] };
    const modelList = Array.isArray(modelsPage.data) ? modelsPage.data : [];

    return processModelList(modelList.map(mapSuperGrokModel), MODEL_LIST_CONFIGS.xai, 'supergrok');
  },
  promptCacheKeyModels: [/^grok-/],
  provider: ModelProvider.SuperGrok,
  responses: {
    handlePayload: handleXAIResponsesPayload,
  },
});
