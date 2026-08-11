import { type EnabledAiModel } from 'model-bank';

import {
  type AiProviderDetailItem,
  type AiProviderListItem,
  type AiProviderRuntimeConfig,
  type EnabledProvider,
  type EnabledProviderWithModels,
} from '@/types/aiProvider';

export interface AIProviderState {
  activeAiProvider?: string;
  activeProviderModelList: any[];
  aiProviderConfigUpdatingIds: string[];
  /**
   * Map of provider id to provider detail, used for caching provider details
   * to avoid data inconsistency when switching providers
   */
  aiProviderDetailMap: Record<string, AiProviderDetailItem>;
  aiProviderList: AiProviderListItem[];
  aiProviderLoadingIds: string[];
  aiProviderRuntimeConfig: Record<string, AiProviderRuntimeConfig>;
  enabledAiModels?: EnabledAiModel[];
  enabledAiProviders?: EnabledProvider[];
  // used for select
  enabledChatModelList?: EnabledProviderWithModels[];
  enabledEmbeddingModelList?: EnabledProviderWithModels[];
  enabledImageModelList?: EnabledProviderWithModels[];
  enabledVideoModelList?: EnabledProviderWithModels[];
  initAiProviderList: boolean;
  isInitAiProviderRuntimeState: boolean;
  /**
   * Retired `${providerId}/${modelId}` → successor model id (same provider).
   * Delivered with the provider runtime state when the server exposes redirects;
   * empty when none are available.
   */
  modelRedirects?: Record<string, string>;
  providerSearchKeyword: string;
}

export const initialAIProviderState: AIProviderState = {
  activeProviderModelList: [],
  aiProviderConfigUpdatingIds: [],
  aiProviderDetailMap: {},
  aiProviderList: [],
  aiProviderLoadingIds: [],
  aiProviderRuntimeConfig: {},
  initAiProviderList: false,
  isInitAiProviderRuntimeState: false,
  providerSearchKeyword: '',
};
