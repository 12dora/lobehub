import type { AiFullModelCard, AiModelType } from 'model-bank';
import { loadModels as loadModelBankModels, ModelProvider } from 'model-bank';

interface LobeHubModelConfig {
  models: AiFullModelCard[];
  planCardModels: string[];
  updatedAt?: string;
  version: number;
}

export interface LobeHubModelPricingContext {
  plan: string;
  scope: 'personal';
}

export interface LobeHubModelPricingOptions {
  pricingContext?: LobeHubModelPricingContext;
}

const getDefaultLobeHubModelConfig = (): LobeHubModelConfig => ({
  models: [],
  planCardModels: [],
  version: 1,
});

const loadLobeHubModelConfig = async (): Promise<LobeHubModelConfig> =>
  getDefaultLobeHubModelConfig();

const loadLobeHubModels = async (): Promise<AiFullModelCard[]> =>
  (await loadLobeHubModelConfig()).models;

/**
 * Stable loaders object so upstream `loadModels` can memoize by identity.
 *
 * No TTL: this is a pure derivation of `loadLobeHubModelConfig()`. The slot
 * key is `version:updatedAt:models.length` — any config/loader change
 * produces a new key and rebuilds. Invalidation is the key changing.
 */
const PROVIDER_LOADERS = {
  [ModelProvider.LobeHub]: loadLobeHubModels,
} as const;

type LoadedModels = Awaited<ReturnType<typeof loadModelBankModels>>;

let modelsMemo: { key: string; models: LoadedModels } | null = null;
let modelsInflight: { key: string; promise: Promise<LoadedModels> } | null = null;

const modelsVersionKey = (config: LobeHubModelConfig): string =>
  `${config.version}:${config.updatedAt ?? ''}:${config.models.length}`;

export const loadModels = async (_options?: LobeHubModelPricingOptions) => {
  const config = await loadLobeHubModelConfig();
  const key = modelsVersionKey(config);
  if (modelsMemo?.key === key) return modelsMemo.models;
  if (modelsInflight?.key === key) return modelsInflight.promise;

  const promise = loadModelBankModels({
    providerLoaders: PROVIDER_LOADERS,
  }).then((models) => {
    modelsMemo = { key, models };
    return models;
  });
  modelsInflight = { key, promise };
  try {
    return await promise;
  } finally {
    if (modelsInflight?.promise === promise) modelsInflight = null;
  }
};

/** Test helper. */
export const resetBusinessLoadModelsMemoForTest = (): void => {
  modelsMemo = null;
  modelsInflight = null;
};

export const loadLobeHubPlanCardModels = async (): Promise<string[]> =>
  (await loadLobeHubModelConfig()).planCardModels;

export const isLobeHubModelAvailable = (
  _id: string,
  _expectedType: AiModelType,
  _options?: {
    getUserEmail?: () => Promise<string | null | undefined>;
    userEmail?: string | null;
  },
): boolean => false;
