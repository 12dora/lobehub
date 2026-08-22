import type { ChatModelCard } from 'model-bank';
import { ModelProvider } from 'model-bank';

import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { MODEL_LIST_CONFIGS, processModelList } from '../../utils/modelParse';
import { handleXAIChatCompletionPayload, handleXAIResponsesPayload } from '../xai';
import { createXAIImage } from '../xai/createImage';
import { createXAIVideo } from '../xai/createVideo';
import type { XAIModelCard } from '../xai/mapXAIModel';
import { mapXAIModel } from '../xai/mapXAIModel';

const SUPERGROK_GENERATION_TYPES = new Set(['image', 'video']);

/**
 * `/v1/models` is chat-oriented and may omit imagine image/video slugs (or list
 * them without `parameters`). Always union the static bank generation cards by
 * id so admin sync / empty gated lists keep `grok-imagine-image` and
 * `grok-imagine-video`.
 */
const unionSuperGrokBankGenerationModels = async (
  processed: ChatModelCard[],
): Promise<ChatModelCard[]> => {
  const { supergrok } = await import('model-bank');
  const bankCards = supergrok.filter((model) => SUPERGROK_GENERATION_TYPES.has(model.type));
  if (bankCards.length === 0) return processed;

  const seen = new Set(processed.map((card) => card.id));
  const missing = bankCards.filter((model) => !seen.has(model.id));
  if (missing.length === 0) return processed;

  const extra = await processModelList(missing, MODEL_LIST_CONFIGS.xai, 'supergrok');
  return [...processed, ...extra];
};

/**
 * SuperGrok / X Premium subscription access to Grok models.
 *
 * Talks to the exact same OpenAI-compatible `https://api.x.ai/v1` endpoint as
 * the `xai` provider (payload handling, image, and video are shared), but
 * authenticates with an OAuth access token instead of an API key. The token is
 * refreshed and injected server-side (see `apps/server` oauthDeviceFlow refresh
 * service) — this runtime stays a stateless bearer client, receiving the fresh
 * token as `apiKey`.
 */
export const LobeSuperGrokAI = createOpenAICompatibleRuntime({
  baseURL: 'https://api.x.ai/v1',
  chatCompletion: {
    handlePayload: handleXAIChatCompletionPayload,
    useResponse: true,
  },
  createImage: createXAIImage,
  createVideo: createXAIVideo,
  handlePollVideoStatus: async (inferenceId, options) => {
    const { pollXAIVideoStatus } = await import('../xai/createVideo');
    return pollXAIVideoStatus(inferenceId, {
      apiKey: options.apiKey,
      baseURL: options.baseURL || '',
    });
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_SUPERGROK_CHAT_COMPLETION === '1',
    responses: () => process.env.DEBUG_SUPERGROK_RESPONSES === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as { data?: XAIModelCard[] };
    if (!Array.isArray(modelsPage?.data)) {
      throw new TypeError('SuperGrok models payload was not a list');
    }

    const processed = await processModelList(
      modelsPage.data.map(mapXAIModel),
      MODEL_LIST_CONFIGS.xai,
      'supergrok',
    );

    return unionSuperGrokBankGenerationModels(processed);
  },
  promptCacheKeyModels: [/^grok-/],
  provider: ModelProvider.SuperGrok,
  responses: {
    handlePayload: handleXAIResponsesPayload,
  },
});
