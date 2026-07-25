import { type AiProviderModelListItem, isAiModelVisible, normalizeAiModelType } from 'model-bank';

import { mergeArrayById } from './merge';

/**
 * Provider-level search defaults (only used when built-in models don't provide
 * settings.searchImpl / settings.searchProvider). Not stored in DB — injected on read.
 */
const PROVIDER_SEARCH_DEFAULTS: Record<
  string,
  { searchImpl?: 'tool' | 'params' | 'internal'; searchProvider?: string }
> = {
  ai360: { searchImpl: 'params' },
  aihubmix: { searchImpl: 'params' },
  anthropic: { searchImpl: 'params' },
  baichuan: { searchImpl: 'params' },
  default: { searchImpl: 'params' },
  google: { searchImpl: 'params', searchProvider: 'google' },
  hunyuan: { searchImpl: 'params' },
  jina: { searchImpl: 'internal' },
  minimax: { searchImpl: 'params' },
  openai: { searchImpl: 'params' },
  perplexity: { searchImpl: 'internal' },
  qwen: { searchImpl: 'params' },
  spark: { searchImpl: 'params' },
  stepfun: { searchImpl: 'params' },
  vertexai: { searchImpl: 'params', searchProvider: 'google' },
  wenxin: { searchImpl: 'params' },
  xai: { searchImpl: 'params' },
  zhipu: { searchImpl: 'params' },
};

const MODEL_SEARCH_DEFAULTS: Record<
  string,
  Record<string, { searchImpl?: 'tool' | 'params' | 'internal'; searchProvider?: string }>
> = {
  openai: {
    'gpt-4o-mini-search-preview': { searchImpl: 'internal' },
    'gpt-4o-search-preview': { searchImpl: 'internal' },
  },
  spark: {
    'max-32k': { searchImpl: 'internal' },
  },
};

const inferProviderSearchDefaults = (
  providerId: string | undefined,
  modelId: string,
): { searchImpl?: 'tool' | 'params' | 'internal'; searchProvider?: string } => {
  const modelSpecificConfig = providerId ? MODEL_SEARCH_DEFAULTS[providerId]?.[modelId] : undefined;
  if (modelSpecificConfig) return modelSpecificConfig;
  return (providerId && PROVIDER_SEARCH_DEFAULTS[providerId]) || PROVIDER_SEARCH_DEFAULTS.default;
};

/**
 * Inject/remove search-related settings based on abilities.search (read-time only).
 * Shared by server AiInfraRepos and admin adapter so both stay on one contract.
 */
export const injectSearchSettings = <T extends Record<string, any>>(
  providerId: string,
  item: T,
): T => {
  const abilities = item?.abilities || {};

  if (abilities.search === false) {
    if (item?.settings?.searchImpl || item?.settings?.searchProvider) {
      const next = { ...item } as any;
      if (next.settings) {
        // eslint-disable-next-line unused-imports/no-unused-vars
        const { searchImpl, searchProvider, ...restSettings } = next.settings;
        next.settings = Object.keys(restSettings).length > 0 ? restSettings : undefined;
      }
      return next;
    }
    return item;
  }

  if (abilities.search === true) {
    if (item?.settings?.searchImpl || item?.settings?.searchProvider) return item;

    const searchSettings = inferProviderSearchDefaults(providerId, item.id);

    return {
      ...item,
      settings: {
        ...item.settings,
        ...searchSettings,
      },
    };
  }

  return item;
};

export interface ProviderModelListPolicyOptions {
  /**
   * Branding provider id whose residual non-builtin rows are pruned.
   * Pass the same constant the server uses (`BRANDING_PROVIDER`).
   */
  brandingProviderId?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
  type?: string;
}

/**
 * Pure merge + post-process policy for a provider's model list.
 * Single source of truth for server repository and admin client adapter.
 */
export const buildProviderModelList = (
  providerId: string,
  defaultModels: AiProviderModelListItem[],
  dbModels: AiProviderModelListItem[],
  options?: ProviderModelListPolicyOptions,
): AiProviderModelListItem[] => {
  let mergedModel = mergeArrayById(defaultModels, dbModels) as AiProviderModelListItem[];

  // Type always prefers builtin config; legacy `stt` → `asr` at read time.
  const builtinTypeMap = new Map(defaultModels.map((m) => [m.id, m.type]));
  for (const m of mergedModel) {
    const builtinType = builtinTypeMap.get(m.id);
    if (builtinType) m.type = builtinType;
    m.type = normalizeAiModelType(m.type);
  }

  if (options?.brandingProviderId && providerId === options.brandingProviderId) {
    const builtinIds = new Set(defaultModels.map((m) => m.id));
    mergedModel = mergedModel.filter((m) => builtinIds.has(m.id));
  }

  mergedModel = mergedModel.filter(isAiModelVisible);

  let list = mergedModel.map((m) =>
    injectSearchSettings(providerId, m),
  ) as AiProviderModelListItem[];

  if (typeof options?.enabled === 'boolean') {
    list = list.filter((m) => m.enabled === options.enabled);
  }

  if (options?.type) {
    list = list.filter((m) => m.type === options.type);
  }

  if (typeof options?.offset === 'number' || typeof options?.limit === 'number') {
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = options?.limit;
    if (typeof limit === 'number') return list.slice(offset, offset + Math.max(0, limit));
    return list.slice(offset);
  }

  return list;
};
