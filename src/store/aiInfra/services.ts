import { type AiModelService, aiModelService } from '@/services/aiModel';
import { type AiProviderService, aiProviderService } from '@/services/aiProvider';

/**
 * Injectable data-source boundary for the aiInfra store.
 * User singleton uses default client services; admin injects platform catalog adapters.
 */
/**
 * Same parameters as the user service method, loosened return type.
 * The store discards every mutation's return value, so adapters may
 * return their own outcome shapes (e.g. publish results).
 */
type LooseReturn<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<unknown>;

export interface AiInfraServices {
  aiModel: Pick<AiModelService, 'getAiProviderModelList'> & {
    batchToggleAiModels: LooseReturn<AiModelService['batchToggleAiModels']>;
    batchUpdateAiModels: LooseReturn<AiModelService['batchUpdateAiModels']>;
    clearModelsByProvider: LooseReturn<AiModelService['clearModelsByProvider']>;
    clearRemoteModels: LooseReturn<AiModelService['clearRemoteModels']>;
    createAiModel: LooseReturn<AiModelService['createAiModel']>;
    deleteAiModel: LooseReturn<AiModelService['deleteAiModel']>;
    toggleModelEnabled: LooseReturn<AiModelService['toggleModelEnabled']>;
    updateAiModel: LooseReturn<AiModelService['updateAiModel']>;
    updateAiModelOrder: LooseReturn<AiModelService['updateAiModelOrder']>;
  };
  aiProvider: Pick<
    AiProviderService,
    'getAiProviderById' | 'getAiProviderList' | 'getAiProviderRuntimeState'
  > & {
    createAiProvider: LooseReturn<AiProviderService['createAiProvider']>;
    deleteAiProvider: LooseReturn<AiProviderService['deleteAiProvider']>;
    toggleProviderEnabled: LooseReturn<AiProviderService['toggleProviderEnabled']>;
    updateAiProvider: LooseReturn<AiProviderService['updateAiProvider']>;
    updateAiProviderConfig: LooseReturn<AiProviderService['updateAiProviderConfig']>;
    updateAiProviderOrder: LooseReturn<AiProviderService['updateAiProviderOrder']>;
  };
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
