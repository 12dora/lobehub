import type {
  AiModelSettings,
  AiModelType,
  LobeDefaultAiModelListItem,
  ModelSearchImplementType,
} from './types';

export interface ResolveSearchDecisionInput {
  modelSearchImpl?: ModelSearchImplementType | null;
  /**
   * Provider id used to default Grok-family models onto native X/web search
   * when the user has not explicitly chosen application search.
   */
  provider?: string | null;
  providerSearchMode?: ModelSearchImplementType | null;
  searchMode?: 'auto' | 'off' | 'on';
  useModelBuiltinSearch?: boolean;
}

export interface SearchDecision {
  enabledSearch: boolean;
  isModelHasBuiltinSearch: boolean;
  isProviderHasBuiltinSearch: boolean;
  useApplicationBuiltinSearchTool: boolean;
  useModelSearch: boolean;
}

/**
 * Providers that prefer native search even when model/provider cards omit
 * search metadata (Grok-family). An explicit `useModelBuiltinSearch === false`
 * still selects the application search tool.
 *
 * Any provider whose model `searchImpl` or provider `searchMode` is
 * `params` | `tool` | `internal` also defaults to native via
 * `resolveSearchDecision` when the toggle is unset.
 */
export const NATIVE_SEARCH_DEFAULT_PROVIDERS = ['grok', 'supergrok', 'xai'] as const;

export const prefersNativeSearchByDefault = (provider?: string | null): boolean =>
  !!provider && (NATIVE_SEARCH_DEFAULT_PROVIDERS as readonly string[]).includes(provider);

/**
 * Whether the Plus / Search controls should expose the App vs Provider Search
 * choice. Grok-family providers always get the three-way menu even when cards
 * omit search metadata, so the UI can restore Provider Search after a toggle.
 */
export const shouldExposeProviderSearchChoice = ({
  isModelBuiltinSearchInternal,
  isModelHasBuiltinSearch,
  isProviderHasBuiltinSearch,
  provider,
}: {
  isModelBuiltinSearchInternal?: boolean;
  isModelHasBuiltinSearch?: boolean;
  isProviderHasBuiltinSearch?: boolean;
  provider?: string | null;
}): boolean =>
  prefersNativeSearchByDefault(provider) ||
  (!isModelBuiltinSearchInternal && !!(isModelHasBuiltinSearch || isProviderHasBuiltinSearch));

/**
 * Resolves the mutually exclusive search route shared by client and server runtimes.
 */
export const resolveSearchDecision = ({
  modelSearchImpl,
  provider,
  providerSearchMode,
  searchMode,
  useModelBuiltinSearch,
}: ResolveSearchDecisionInput): SearchDecision => {
  const enabledSearch = searchMode !== 'off';
  const isModelHasBuiltinSearch = !!modelSearchImpl;
  const isProviderHasBuiltinSearch = !!providerSearchMode;
  const isBuiltinSearchInternal =
    modelSearchImpl === 'internal' || providerSearchMode === 'internal';
  const preferNative = prefersNativeSearchByDefault(provider);
  const hasNativeSearchCapability =
    isModelHasBuiltinSearch || isProviderHasBuiltinSearch || preferNative;
  // True `internal` models (Perplexity, search-preview, …) always use native
  // search. Grok-family is the exception: an explicit App Search choice must
  // win even if a managed card marked the impl `internal`.
  const forceNativeInternal =
    isBuiltinSearchInternal && !(preferNative && useModelBuiltinSearch === false);
  const nativeSearchSelected =
    forceNativeInternal || (hasNativeSearchCapability && (useModelBuiltinSearch ?? true));
  const useModelSearch = enabledSearch && nativeSearchSelected;

  return {
    enabledSearch,
    isModelHasBuiltinSearch,
    isProviderHasBuiltinSearch,
    useApplicationBuiltinSearchTool: enabledSearch && !useModelSearch,
    useModelSearch,
  };
};

type ModelSearchSettings = Pick<AiModelSettings, 'searchImpl' | 'searchProvider'>;

const PROVIDER_SEARCH_DEFAULTS: Record<string, ModelSearchSettings> = {
  ai360: { searchImpl: 'params' },
  aihubmix: { searchImpl: 'params' },
  anthropic: { searchImpl: 'params' },
  baichuan: { searchImpl: 'params' },
  chatgpt: { searchImpl: 'params' },
  cursor: { searchImpl: 'params' },
  default: { searchImpl: 'params' },
  google: { searchImpl: 'params', searchProvider: 'google' },
  grok: { searchImpl: 'params' },
  hunyuan: { searchImpl: 'params' },
  jina: { searchImpl: 'internal' },
  minimax: { searchImpl: 'params' },
  openai: { searchImpl: 'params' },
  perplexity: { searchImpl: 'internal' },
  qwen: { searchImpl: 'params' },
  spark: { searchImpl: 'params' },
  stepfun: { searchImpl: 'params' },
  supergrok: { searchImpl: 'params' },
  vertexai: { searchImpl: 'params', searchProvider: 'google' },
  wenxin: { searchImpl: 'params' },
  xai: { searchImpl: 'params' },
  zhipu: { searchImpl: 'params' },
};

const MODEL_SEARCH_DEFAULTS: Record<string, Record<string, ModelSearchSettings>> = {
  openai: {
    'gpt-4o-mini-search-preview': { searchImpl: 'internal' },
    'gpt-4o-search-preview': { searchImpl: 'internal' },
  },
  spark: {
    'max-32k': { searchImpl: 'internal' },
  },
};

/**
 * Infers search settings for remotely discovered models that only expose abilities.search.
 */
export const resolveModelSearchDefaultSettings = (
  providerId: string | undefined,
  modelId: string,
): ModelSearchSettings =>
  (providerId && MODEL_SEARCH_DEFAULTS[providerId]?.[modelId]) ||
  (providerId && PROVIDER_SEARCH_DEFAULTS[providerId]) ||
  PROVIDER_SEARCH_DEFAULTS.default;

export const isProviderModelAvailable = (
  models: LobeDefaultAiModelListItem[],
  providerId: string,
  id: string,
  expectedType: AiModelType,
): boolean =>
  models.some(
    (model) =>
      model.providerId === providerId &&
      model.id === id &&
      model.enabled !== false &&
      model.type === expectedType,
  );
