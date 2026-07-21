import { type AiModelService, aiModelService } from '@/services/aiModel';
import { type AiProviderService, aiProviderService } from '@/services/aiProvider';

/**
 * Injectable data-source boundary for the aiInfra store.
 * User singleton uses default client services; admin injects platform catalog adapters.
 */
export interface AiInfraServices {
  aiModel: Pick<
    AiModelService,
    | 'batchToggleAiModels'
    | 'batchUpdateAiModels'
    | 'clearModelsByProvider'
    | 'clearRemoteModels'
    | 'createAiModel'
    | 'deleteAiModel'
    | 'getAiProviderModelList'
    | 'toggleModelEnabled'
    | 'updateAiModel'
    | 'updateAiModelOrder'
  >;
  aiProvider: Pick<
    AiProviderService,
    | 'createAiProvider'
    | 'deleteAiProvider'
    | 'getAiProviderById'
    | 'getAiProviderList'
    | 'getAiProviderRuntimeState'
    | 'toggleProviderEnabled'
    | 'updateAiProvider'
    | 'updateAiProviderConfig'
    | 'updateAiProviderOrder'
  >;
  /**
   * SWR key namespace so admin/user store instances do not share cache entries.
   * Default `'user'` preserves existing keys for the singleton.
   */
  swrScope?: string;
}

export const defaultAiInfraServices: AiInfraServices = {
  aiModel: aiModelService,
  aiProvider: aiProviderService,
  swrScope: 'user',
};
