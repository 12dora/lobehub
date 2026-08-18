import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { processMultiProviderModelList } from '../../utils/modelParse';

/** OpenAI-compatible `/v1/models` item — id only. Used on the 404 fallback. */
export interface LMStudioModelCard {
  id: string;
}

/**
 * Native `GET /api/v1/models` item (LM Studio 0.4.0+).
 * @see https://lmstudio.ai/docs/developer/rest/list
 */
export interface LMStudioNativeModel {
  capabilities?: {
    reasoning?: {
      allowed_options?: Array<'high' | 'low' | 'medium' | 'off' | 'on'>;
      default?: string;
    };
    trained_for_tool_use?: boolean;
    vision?: boolean;
  };
  description?: string | null;
  display_name?: string;
  key: string;
  max_context_length?: number;
  type?: 'embedding' | 'llm';
}

const DEFAULT_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234/v1';

const resolveLmStudioNativeModelsUrl = (baseURL?: string) => {
  const openaiBase = (baseURL || DEFAULT_LMSTUDIO_BASE_URL).replace(/\/+$/, '');
  const origin = openaiBase.replace(/\/v1$/i, '');
  return `${origin}/api/v1/models`;
};

const optionalBool = (value: boolean | undefined) =>
  typeof value === 'boolean' ? value : undefined;

const mapLmStudioReasoning = (
  reasoning: NonNullable<LMStudioNativeModel['capabilities']>['reasoning'],
): true | undefined => {
  const options = reasoning?.allowed_options;
  if (!Array.isArray(options)) return undefined;
  // Presence of any option other than "off" is the groundable fact (R4 §4.2).
  return options.some((option) => option !== 'off') ? true : undefined;
};

const mapNativeLmStudioModel = (model: LMStudioNativeModel) => {
  const capabilities = model.capabilities;

  return {
    contextWindowTokens: model.max_context_length,
    description: model.description ?? undefined,
    displayName: model.display_name,
    functionCall: optionalBool(capabilities?.trained_for_tool_use),
    id: model.key,
    reasoning: mapLmStudioReasoning(capabilities?.reasoning),
    type: model.type === 'embedding' ? 'embedding' : model.type === 'llm' ? 'chat' : undefined,
    vision: optionalBool(capabilities?.vision),
  };
};

const fetchNativeLmStudioModels = async (client: {
  // The OpenAI client types `apiKey` as nullable; LM Studio ignores it anyway (the placeholder
  // above exists only so the SDK constructs), so accept both and send the header only when set.
  apiKey?: string | null;
  baseURL?: string;
}): Promise<LMStudioNativeModel[] | 'fallback'> => {
  const response = await fetch(resolveLmStudioNativeModelsUrl(client.baseURL), {
    headers: {
      Accept: 'application/json',
      ...(client.apiKey ? { Authorization: `Bearer ${client.apiKey}` } : {}),
    },
    method: 'GET',
  });

  // Native REST shipped in 0.4.0; older installs 404 and must keep using /v1/models.
  if (response.status === 404) return 'fallback';

  if (!response.ok) {
    throw new Error(
      `LM Studio native models API failed: ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as { models?: LMStudioNativeModel[] };
  return Array.isArray(body.models) ? body.models : [];
};

export const params = {
  apiKey: 'placeholder-to-avoid-error',
  baseURL: DEFAULT_LMSTUDIO_BASE_URL,
  debug: {
    chatCompletion: () => process.env.DEBUG_LMSTUDIO_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const nativeList = await fetchNativeLmStudioModels(client);

    if (nativeList === 'fallback') {
      const modelsPage = (await client.models.list()) as { data?: LMStudioModelCard[] };
      const modelList = Array.isArray(modelsPage?.data) ? modelsPage.data : [];

      return processMultiProviderModelList(
        modelList.filter((model) => model?.id).map((model) => ({ id: model.id })),
        'lmstudio',
      );
    }

    return processMultiProviderModelList(
      nativeList.filter((model) => model?.key).map(mapNativeLmStudioModel),
      'lmstudio',
    );
  },
  provider: ModelProvider.LMStudio,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeLMStudioAI = createOpenAICompatibleRuntime(params);
