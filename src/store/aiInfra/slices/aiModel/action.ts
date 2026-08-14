import isEqual from 'fast-deep-equal';
import {
  type AiModelSortMap,
  type AiProviderModelListItem,
  type CreateAiModelParams,
  type ToggleAiModelEnableParams,
} from 'model-bank';
import { type SWRResponse } from 'swr';

import { mutate, useClientDataSWR } from '@/libs/swr';
import { aiModelKeys } from '@/libs/swr/keys';
import type { GetAiProviderModelListParams } from '@/services/aiModel';
import { type AiInfraServices } from '@/store/aiInfra/services';
import { type AiInfraStore } from '@/store/aiInfra/store';
import { type StoreSetter } from '@/store/types';

type Setter = StoreSetter<AiInfraStore>;

export const createAiModelSlice =
  (services: AiInfraServices) => (set: Setter, get: () => AiInfraStore, _api?: unknown) =>
    new AiModelActionImpl(set, get, services);

export class AiModelActionImpl {
  readonly #get: () => AiInfraStore;
  readonly #services: AiInfraServices;
  readonly #set: Setter;

  constructor(set: Setter, get: () => AiInfraStore, services: AiInfraServices) {
    this.#set = set;
    this.#get = get;
    this.#services = services;
  }

  #scopeKey = <T extends readonly unknown[]>(base: T) => {
    const scope = this.#services.swrScope ?? 'user';
    if (scope === 'user') return base;
    return [scope, ...base] as const;
  };

  #modelListKey = (providerId: string | undefined) => {
    return this.#scopeKey(aiModelKeys.list(providerId));
  };

  /**
   * Scope-aware SWR key for disabled-model infinite pages.
   * Admin stores prefix with swrScope so user/admin caches never collide.
   */
  getDisabledModelsPageKey = (providerId: string, offset: number) => {
    return this.#scopeKey(aiModelKeys.disabledModelsPage(providerId, offset));
  };

  /**
   * Paged model list via the injected service boundary (user or admin adapter).
   * DisabledModels must call this instead of the user singleton service.
   */
  getAiProviderModelPage = (
    id: string,
    params?: GetAiProviderModelListParams,
  ): Promise<AiProviderModelListItem[]> => {
    return this.#services.aiModel.getAiProviderModelList(id, params);
  };

  batchToggleAiModels = async (ids: string[], enabled: boolean): Promise<void> => {
    const { activeAiProvider } = this.#get();
    if (!activeAiProvider) return;

    await this.#services.aiModel.batchToggleAiModels(activeAiProvider, ids, enabled);
    await this.#get().refreshAiModelList();
  };

  batchUpdateAiModels = async (models: AiProviderModelListItem[]): Promise<void> => {
    const { activeAiProvider: id } = this.#get();
    if (!id) return;

    await this.#services.aiModel.batchUpdateAiModels(id, models);
    await this.#get().refreshAiModelList();
  };

  clearModelsByProvider = async (provider: string): Promise<void> => {
    await this.#services.aiModel.clearModelsByProvider(provider);
    await this.#get().refreshAiModelList();
  };

  clearRemoteModels = async (provider: string): Promise<void> => {
    await this.#services.aiModel.clearRemoteModels(provider);
    await this.#get().refreshAiModelList();
  };

  createNewAiModel = async (data: CreateAiModelParams): Promise<void> => {
    await this.#services.aiModel.createAiModel(data);
    await this.#get().refreshAiModelList();
  };

  fetchRemoteModelList = async (providerId: string): Promise<void> => {
    const { modelsService } = await import('@/services/models');

    const data = await modelsService.getModels(providerId);
    if (data) {
      const currentEnabledState = new Map(
        this.#get().aiProviderModelList.map(({ enabled, id }) => [id, enabled]),
      );
      await this.#get().batchUpdateAiModels(
        data.map((model) => {
          const result: any = {
            ...model,
            enabled: currentEnabledState.get(model.id) ?? model.enabled ?? false,
            source: 'remote',
          };

          // Only include abilities if at least one capability is truthy
          const hasAnyAbility =
            model.files ||
            model.functionCall ||
            model.imageOutput ||
            model.reasoning ||
            model.search ||
            model.video ||
            model.vision;

          if (hasAnyAbility) {
            result.abilities = {
              files: model.files,
              functionCall: model.functionCall,
              imageOutput: model.imageOutput,
              reasoning: model.reasoning,
              search: model.search,
              video: model.video,
              vision: model.vision,
            };
          }

          // Always include type to enable remote updates
          // The SQL layer will preserve non-chat types when remote sends 'chat'
          // This allows correcting misclassified models (e.g., image → video)
          if (model.type) {
            result.type = model.type;
          }

          return result;
        }),
      );

      await this.#get().refreshAiModelList();
    }
  };

  internal_toggleAiModelLoading = (id: string, loading: boolean): void => {
    this.#set(
      (state) => {
        if (loading) return { aiModelLoadingIds: [...state.aiModelLoadingIds, id] };

        return { aiModelLoadingIds: state.aiModelLoadingIds.filter((i) => i !== id) };
      },
      false,
      'toggleAiModelLoading',
    );
  };

  refreshAiModelList = async (): Promise<void> => {
    await mutate(this.#modelListKey(this.#get().activeAiProvider));
    // make refresh provide runtime state async, not block
    this.#get().refreshAiProviderRuntimeState();
  };

  removeAiModel = async (id: string, providerId: string): Promise<void> => {
    await this.#services.aiModel.deleteAiModel({ id, providerId });
    await this.#get().refreshAiModelList();
  };

  /**
   * Toggle a model of an arbitrary provider, without requiring the provider settings
   * page context (`activeAiProvider`). Used by ModelSelect to re-enable a persisted
   * model that is no longer in the enabled list.
   */
  toggleProviderModelEnabled = async (params: ToggleAiModelEnableParams): Promise<void> => {
    this.#get().internal_toggleAiModelLoading(params.id, true);

    try {
      await this.#services.aiModel.toggleModelEnabled(params);
      await this.#get().refreshAiProviderRuntimeState();
    } finally {
      this.#get().internal_toggleAiModelLoading(params.id, false);
    }
  };

  toggleModelEnabled = async (
    params: Omit<ToggleAiModelEnableParams, 'providerId'>,
  ): Promise<void> => {
    const { activeAiProvider } = this.#get();
    if (!activeAiProvider) return;

    this.#get().internal_toggleAiModelLoading(params.id, true);

    try {
      await this.#services.aiModel.toggleModelEnabled({ ...params, providerId: activeAiProvider });
      await this.#get().refreshAiModelList();
    } finally {
      // Always clear the spinner: a rejected write (admin applyImmediate, network) already
      // surfaced a toast, and a switch that keeps spinning forever is not a recoverable state.
      this.#get().internal_toggleAiModelLoading(params.id, false);
    }
  };

  updateAiModelsConfig = async (
    id: string,
    providerId: string,
    data: Partial<AiProviderModelListItem>,
  ): Promise<void> => {
    await this.#services.aiModel.updateAiModel(id, providerId, data);
    await this.#get().refreshAiModelList();
  };

  updateAiModelsSort = async (id: string, items: AiModelSortMap[]): Promise<void> => {
    await this.#services.aiModel.updateAiModelOrder(id, items);
    await this.#get().refreshAiModelList();
  };

  useFetchAiProviderModels = (id: string): SWRResponse<AiProviderModelListItem[]> => {
    return useClientDataSWR<AiProviderModelListItem[]>(
      this.#modelListKey(id),
      () => this.#services.aiModel.getAiProviderModelList(id),
      {
        onSuccess: (data) => {
          // no need to update list if the list have been init and data is the same
          if (this.#get().isAiModelListInit && isEqual(data, this.#get().aiProviderModelList))
            return;

          this.#set(
            { aiProviderModelList: data, isAiModelListInit: true },
            false,
            `useFetchAiProviderModels/${id}`,
          );
        },
      },
    );
  };
}

export type AiModelAction = Pick<AiModelActionImpl, keyof AiModelActionImpl>;
