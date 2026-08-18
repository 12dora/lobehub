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

/**
 * What an upstream sync actually changed, reported to the operator verbatim.
 * `total` is what upstream enumerated; `created` the keys that had no row before.
 */
export interface UpstreamModelSyncResult {
  created: number;
  total: number;
  updated: number;
}

export interface AiInfraServices {
  aiModel: Pick<AiModelService, 'getAiProviderModelList'> & {
    batchToggleAiModels: LooseReturn<AiModelService['batchToggleAiModels']>;
    batchUpdateAiModels: LooseReturn<AiModelService['batchUpdateAiModels']>;
    clearModelsByProvider: LooseReturn<AiModelService['clearModelsByProvider']>;
    clearRemoteModels: LooseReturn<AiModelService['clearRemoteModels']>;
    createAiModel: LooseReturn<AiModelService['createAiModel']>;
    deleteAiModel: LooseReturn<AiModelService['deleteAiModel']>;
    /**
     * Enumerate upstream against the credential THIS panel owns and persist the result.
     *
     * Only the admin adapter implements it: the platform catalog's credential is a shared
     * OAuth account in the platform vault, which the user route (`GET /webapi/models`) cannot
     * read — it opens the caller's personal vault, and under platform takeover it does not
     * call upstream at all, it replays the already-published catalog. A store whose services
     * omit this falls back to the member's own BYOK fetch.
     *
     * Contract: rejections are reported by the CALLER, not the implementation — one model-list
     * message per attempt. An implementation may still prompt for re-authentication first.
     */
    syncUpstreamModels?: (providerId: string) => Promise<UpstreamModelSyncResult>;
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
