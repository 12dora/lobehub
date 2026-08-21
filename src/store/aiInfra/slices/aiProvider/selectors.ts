import { isProviderDisableBrowserRequest, isWebAppProvider } from 'model-bank/modelProviders';

import { type AIProviderStoreState } from '@/store/aiInfra/initialState';
import { type AiProviderRuntimeConfig } from '@/types/aiProvider';
import { AiProviderSourceEnum } from '@/types/aiProvider';
import { type GlobalLLMProviderKey } from '@/types/user/settings';

// List
const enabledAiProviderList = (s: AIProviderStoreState) =>
  s.aiProviderList.filter((item) => item.enabled).sort((a, b) => a.sort! - b.sort!);

const disabledAiProviderList = (s: AIProviderStoreState) =>
  s.aiProviderList.filter((item) => !item.enabled && item.source !== AiProviderSourceEnum.Custom);

const disabledCustomAiProviderList = (s: AIProviderStoreState) =>
  s.aiProviderList.filter((item) => !item.enabled && item.source === AiProviderSourceEnum.Custom);

const enabledEmbeddingModelList = (s: AIProviderStoreState) => s.enabledEmbeddingModelList || [];

const enabledImageModelList = (s: AIProviderStoreState) => s.enabledImageModelList || [];

const enabledVideoModelList = (s: AIProviderStoreState) => s.enabledVideoModelList || [];

const isProviderEnabled = (id: string) => (s: AIProviderStoreState) =>
  enabledAiProviderList(s).some((i) => i.id === id);

const isProviderLoading = (id: string) => (s: AIProviderStoreState) =>
  s.aiProviderLoadingIds.includes(id);

/**
 * Stored description of a provider, the only place a CUSTOM provider's description exists on
 * the client — builtin ids carry theirs in the model-bank card instead (see
 * `useProviderDescription`, which prefers the localized card copy and falls back to this).
 */
const providerDescriptionById = (id: string | undefined) => (s: AIProviderStoreState) =>
  id ? s.aiProviderList.find((item) => item.id === id)?.description : undefined;

/**
 * Stored display name of a provider — the only place a CUSTOM provider's name exists on the
 * client. Builtin ids carry theirs in the model-bank card (localized by `useProviderName`),
 * so callers pass `undefined` for those rather than paying for a list scan that would answer
 * with the same string.
 */
const providerNameById = (id: string | undefined) => (s: AIProviderStoreState) =>
  id ? s.aiProviderList.find((item) => item.id === id)?.name : undefined;

// Detail

/**
 * Get provider detail by id from the cache map
 */
const providerDetailById = (id: string) => (s: AIProviderStoreState) => s.aiProviderDetailMap[id];

/**
 * Get active provider config from the cache map
 */
const activeProviderConfig = (s: AIProviderStoreState) =>
  s.activeAiProvider ? s.aiProviderDetailMap[s.activeAiProvider] : undefined;

/**
 * Check if provider config is loading (data not yet in cache)
 */
const isAiProviderConfigLoading = (id: string) => (s: AIProviderStoreState) =>
  !s.aiProviderDetailMap[id];

const providerWhitelist = new Set(['ollama', 'lmstudio']);

const activeProviderKeyVaults = (s: AIProviderStoreState) => activeProviderConfig(s)?.keyVaults;

const isActiveProviderEndpointNotEmpty = (s: AIProviderStoreState) => {
  const vault = activeProviderKeyVaults(s);
  return !!vault?.baseURL || !!vault?.endpoint;
};

const isActiveProviderApiKeyNotEmpty = (s: AIProviderStoreState) => {
  const vault = activeProviderKeyVaults(s);
  return !!vault?.apiKey || !!vault?.accessKeyId || !!vault?.secretAccessKey;
};

const providerConfigById =
  (id: string) =>
  (s: AIProviderStoreState): AiProviderRuntimeConfig | undefined => {
    if (!id) return undefined;

    return s.aiProviderRuntimeConfig?.[id];
  };

const isProviderConfigUpdating = (id: string) => (s: AIProviderStoreState) =>
  s.aiProviderConfigUpdatingIds.includes(id);

/**
 * @description The conditions to enable client fetch
 * 1. If no baseUrl and apikey input, force on Server.
 * 2. If only contains baseUrl, force on Client
 * 3. Follow the user settings.
 * 4. On Server, by default.
 */
const isProviderFetchOnClient =
  (provider: GlobalLLMProviderKey | string) => (s: AIProviderStoreState) => {
    const config = providerConfigById(provider)(s);

    // If the provider already disable browser request in model config, force on Server.
    if (isProviderDisableBrowserRequest(provider)) return false;

    // If the provider in the whitelist, follow the user settings
    if (providerWhitelist.has(provider) && typeof config?.fetchOnClient !== 'undefined')
      return config?.fetchOnClient;

    // 1. If no baseUrl and apikey input, force on Server.
    const isProviderEndpointNotEmpty = !!config?.keyVaults.baseURL;
    const isProviderApiKeyNotEmpty = !!config?.keyVaults.apiKey;
    if (!isProviderEndpointNotEmpty && !isProviderApiKeyNotEmpty) return false;

    // 2. If only contains baseUrl, force on Client
    if (isProviderEndpointNotEmpty && !isProviderApiKeyNotEmpty) return true;

    // 3. Follow the user settings.
    if (typeof config?.fetchOnClient !== 'undefined') return config?.fetchOnClient;

    // 4. On Server, by default.
    return false;
  };

const providerKeyVaults = (provider: string | undefined) => (s: AIProviderStoreState) => {
  if (!provider) return undefined;

  return s.aiProviderRuntimeConfig?.[provider]?.keyVaults;
};

const isProviderHasBuiltinSearch = (provider: string) => (s: AIProviderStoreState) => {
  const config = providerConfigById(provider)(s);

  return !!config?.settings.searchMode;
};

const isProviderHasBuiltinSearchConfig = (id: string) => (s: AIProviderStoreState) => {
  const providerCfg = providerConfigById(id)(s);

  return !!providerCfg?.settings.searchMode && providerCfg?.settings.searchMode !== 'internal';
};

const isProviderBuiltinSearchInternal = (id: string) => (s: AIProviderStoreState) => {
  const providerCfg = providerConfigById(id)(s);

  return providerCfg?.settings.searchMode === 'internal';
};

const isProviderEnableResponseApi = (id: string) => (s: AIProviderStoreState) => {
  const providerCfg = providerConfigById(id)(s);

  const enableResponseApi = providerCfg?.config?.enableResponseApi;

  if (typeof enableResponseApi === 'boolean') return enableResponseApi;

  return id === 'openai';
};

/**
 * Whether this request provider is a web-app runtime (ChatGPT / Cursor / Grok
 * web). Builtin catalog ids are recognised from the model-bank card; managed
 * aliases (`corp-cursor`) use the server-projected `capabilities.webApp` flag.
 * User `settings.webApp` is never trusted.
 */
const isProviderWebApp = (id?: string) => (s: AIProviderStoreState) => {
  if (!id) return false;
  if (isWebAppProvider(id)) return true;
  return providerConfigById(id)(s)?.capabilities?.webApp === true;
};

const isInitAiProviderRuntimeState = (s: AIProviderStoreState) => !!s.isInitAiProviderRuntimeState;

export const aiProviderSelectors = {
  activeProviderConfig,
  disabledAiProviderList,
  disabledCustomAiProviderList,
  enabledAiProviderList,
  enabledEmbeddingModelList,
  enabledImageModelList,
  enabledVideoModelList,
  isActiveProviderApiKeyNotEmpty,
  isActiveProviderEndpointNotEmpty,
  isAiProviderConfigLoading,
  isInitAiProviderRuntimeState,
  isProviderConfigUpdating,
  isProviderEnableResponseApi,
  isProviderEnabled,
  isProviderFetchOnClient,
  isProviderBuiltinSearchInternal,
  isProviderHasBuiltinSearch,
  isProviderHasBuiltinSearchConfig,
  isProviderLoading,
  isProviderWebApp,
  providerConfigById,
  providerDescriptionById,
  providerDetailById,
  providerKeyVaults,
  providerNameById,
};
