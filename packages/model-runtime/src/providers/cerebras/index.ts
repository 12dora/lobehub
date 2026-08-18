import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { processMultiProviderModelList } from '../../utils/modelParse';

const DEFAULT_CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

/**
 * Public catalog, default Cerebras format (omit `format`).
 * That pin returns `pricing.prompt` / `pricing.completion` as USD-per-token
 * decimal strings; `?format=huggingface` is the same numbers already × 1e6.
 */
const resolveCerebrasPublicModelsUrl = (baseURL?: string) => {
  const openaiBase = (baseURL || DEFAULT_CEREBRAS_BASE_URL).replace(/\/+$/, '');
  const origin = openaiBase.replace(/\/v1$/i, '');
  return `${origin}/public/v1/models`;
};

export interface CerebrasAuthModel {
  created?: number;
  id: string;
  object?: string;
  owned_by?: string;
}

export interface CerebrasPublicModel {
  capabilities?: {
    function_calling?: boolean;
    reasoning?: boolean;
    vision?: boolean;
  };
  description?: string;
  id: string;
  limits?: {
    max_completion_tokens?: number;
    max_context_length?: number;
  };
  name?: string;
  pricing?: {
    completion?: number | string;
    prompt?: number | string;
  };
}

/**
 * Default Cerebras format: USD per single token. formatPricing expects
 * USD per million tokens, so × 1e6. 0.00000099 × 1e6 = 0.99.
 */
const usdPerTokenToPerMillion = (value: number | string | undefined): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n * 1e6;
};

const optionalBool = (value: boolean | undefined) =>
  typeof value === 'boolean' ? value : undefined;

const mapCerebrasPublicEnrichment = (pub: CerebrasPublicModel) => {
  const input = usdPerTokenToPerMillion(pub.pricing?.prompt);
  const output = usdPerTokenToPerMillion(pub.pricing?.completion);

  return {
    contextWindowTokens: pub.limits?.max_context_length,
    description: pub.description,
    displayName: pub.name,
    functionCall: optionalBool(pub.capabilities?.function_calling),
    maxOutput: pub.limits?.max_completion_tokens,
    pricing: input !== undefined || output !== undefined ? { input, output } : undefined,
    reasoning: optionalBool(pub.capabilities?.reasoning),
    vision: optionalBool(pub.capabilities?.vision),
  };
};

const loadCerebrasPublicCatalog = async (
  baseURL?: string,
): Promise<Map<string, CerebrasPublicModel>> => {
  const catalog = new Map<string, CerebrasPublicModel>();

  try {
    const response = await fetch(resolveCerebrasPublicModelsUrl(baseURL));
    if (!response.ok) return catalog;

    const body = (await response.json()) as
      CerebrasPublicModel[] | { data?: CerebrasPublicModel[] };
    const list = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : [];

    for (const item of list) {
      if (item?.id) catalog.set(item.id, item);
    }
  } catch {
    // Public list is enrichment only; a failure must not fail /v1/models.
  }

  return catalog;
};

export const params = {
  baseURL: DEFAULT_CEREBRAS_BASE_URL,
  chatCompletion: {
    handlePayload: (payload) => {
      // eslint-disable-next-line unused-imports/no-unused-vars
      const { frequency_penalty, presence_penalty, model, ...rest } = payload;

      return {
        ...rest,
        model,
      } as any;
    },
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_CEREBRAS_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as
      CerebrasAuthModel[] | { data?: CerebrasAuthModel[] };
    const modelList = Array.isArray(modelsPage)
      ? modelsPage
      : Array.isArray(modelsPage?.data)
        ? modelsPage.data
        : [];

    const publicById = await loadCerebrasPublicCatalog(client.baseURL);

    const enriched = modelList
      .filter((model) => model?.id)
      .map((model) => {
        const pub = publicById.get(model.id);
        if (!pub) {
          // Missing from the public subset — no metadata, by design.
          return { id: model.id };
        }

        return { id: model.id, ...mapCerebrasPublicEnrichment(pub) };
      });

    return processMultiProviderModelList(enriched, 'cerebras');
  },
  provider: ModelProvider.Cerebras,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeCerebrasAI = createOpenAICompatibleRuntime(params);
