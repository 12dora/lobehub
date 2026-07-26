import { BRANDING_PROVIDER } from '@lobechat/business-const';
import { buildProviderModelList } from '@lobechat/utils';
import type {
  AiModelSortMap,
  AiProviderModelListItem,
  CreateAiModelParams,
  ToggleAiModelEnableParams,
  UpdateAiModelParams,
} from 'model-bank';
import { AiModelSourceEnum, LOBE_DEFAULT_MODEL_LIST } from 'model-bank';

import { lambdaClient } from '@/libs/trpc/client';
import type { GetAiProviderModelListParams } from '@/services/aiModel';

import { mapModelListItem } from './mappers';
import {
  DEFAULT_REASON,
  getDetail,
  isPlatformNotFoundError,
  recordPublishOutcome,
  withReauth,
} from './shared';

const normalizeContextWindowTokens = (value: number | null | undefined) =>
  value === 0 ? null : value;

/**
 * Admin adapter for AI model mutations/list — same surface as user AiModelService.
 * Lives in its own module (#49); barrel re-exports from index.ts.
 */
export class AdminAiModelService {
  #resolveModelUuid = async (providerKey: string, modelKeyOrId: string) => {
    const detail = await getDetail(providerKey);
    const model =
      detail.draft.models.find((m) => m.modelKey === modelKeyOrId || m.id === modelKeyOrId) ?? null;
    return { detail, model };
  };

  createAiModel = async (params: CreateAiModelParams) => {
    const detail = await getDetail(params.providerId);
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiModels.applyImmediate.mutate({
        abilities: params.abilities as Record<string, unknown> | undefined,
        contextWindowTokens: normalizeContextWindowTokens(params.contextWindowTokens) ?? null,
        displayName: params.displayName ?? null,
        enabled: true,
        expectedDraftToken: detail.draftToken,
        modelKey: params.id,
        operation: 'create',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
        settings: params.settings as Record<string, unknown> | undefined,
        type: params.type ?? 'chat',
      });
      recordPublishOutcome(params.providerId, result);
      return result;
    });
  };

  getAiProviderModelList = async (
    id: string,
    params?: GetAiProviderModelListParams,
  ): Promise<AiProviderModelListItem[]> => {
    // Built-in model catalog from client-side model-bank, mirroring the server repo's
    // fetchBuiltinModels fallback so every provider shows its full model list even before
    // a platform DB row exists.
    const builtinModels = LOBE_DEFAULT_MODEL_LIST.filter((model) => model.providerId === id).map(
      (model): AiProviderModelListItem => ({
        ...model,
        enabled: model.enabled || false,
        source: AiModelSourceEnum.Builtin,
      }),
    );

    let dbModels: AiProviderModelListItem[] = [];
    try {
      const detail = await getDetail(id);
      dbModels = detail.draft.models.map(mapModelListItem);
    } catch (cause) {
      // No platform row yet → built-ins only. Rethrow permission/network/server failures.
      if (!isPlatformNotFoundError(cause)) throw cause;
    }

    // Shared pure policy with server AiInfraRepos — no client-side drift.
    return buildProviderModelList(id, builtinModels, dbModels, {
      brandingProviderId: BRANDING_PROVIDER,
      enabled: params?.enabled,
      limit: params?.limit,
      offset: params?.offset,
    });
  };

  toggleModelEnabled = async (params: ToggleAiModelEnableParams) => {
    const { detail, model } = await this.#resolveModelUuid(params.providerId, params.id);
    if (!model) throw new Error(`Model not found: ${params.id}`);
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiModels.applyImmediate.mutate({
        enabled: params.enabled,
        expectedDraftToken: detail.draftToken,
        expectedRevision: model.revision,
        id: model.id,
        operation: 'update',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
      });
      recordPublishOutcome(params.providerId, result);
      return result;
    });
  };

  updateAiModel = async (id: string, providerId: string, value: UpdateAiModelParams) => {
    const { detail, model } = await this.#resolveModelUuid(providerId, id);
    if (!model) throw new Error(`Model not found: ${id}`);
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiModels.applyImmediate.mutate({
        abilities: value.abilities as Record<string, unknown> | undefined,
        config: value.config as Record<string, unknown> | null | undefined,
        contextWindowTokens: normalizeContextWindowTokens(value.contextWindowTokens),
        displayName: value.displayName ?? undefined,
        expectedDraftToken: detail.draftToken,
        expectedRevision: model.revision,
        id: model.id,
        operation: 'update',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
        settings: value.settings as Record<string, unknown> | undefined,
        type: value.type,
      });
      recordPublishOutcome(providerId, result);
      return result;
    });
  };

  batchUpdateAiModels = async (providerId: string, models: AiProviderModelListItem[]) => {
    const detail = await getDetail(providerId);
    const mapped = models.map((m) => {
      const existing = detail.draft.models.find((d) => d.modelKey === m.id || d.id === m.id);
      return {
        abilities: m.abilities as Record<string, unknown> | undefined,
        config: m.config as Record<string, unknown> | null | undefined,
        contextWindowTokens: normalizeContextWindowTokens(m.contextWindowTokens) ?? null,
        displayName: m.displayName ?? null,
        enabled: m.enabled,
        id: existing?.id ?? m.id,
        parameters: m.parameters as Record<string, unknown> | undefined,
        pricing: m.pricing as Record<string, unknown> | null | undefined,
        settings: m.settings as Record<string, unknown> | undefined,
        type: m.type,
      };
    });
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiModels.applyImmediate.mutate({
        expectedDraftToken: detail.draftToken,
        models: mapped,
        operation: 'batchUpdate',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
      });
      recordPublishOutcome(providerId, result);
      return result;
    });
  };

  batchToggleAiModels = async (providerId: string, models: string[], enabled: boolean) => {
    const detail = await getDetail(providerId);
    const modelIds = models.map((key) => {
      const found = detail.draft.models.find((m) => m.modelKey === key || m.id === key);
      if (!found) throw new Error(`Model not found: ${key}`);
      return found.id;
    });
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiModels.applyImmediate.mutate({
        enabled,
        expectedDraftToken: detail.draftToken,
        modelIds,
        operation: 'batchToggle',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
      });
      recordPublishOutcome(providerId, result);
      return result;
    });
  };

  clearModelsByProvider = async (providerId: string) => {
    const detail = await getDetail(providerId);
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiModels.applyImmediate.mutate({
        expectedDraftToken: detail.draftToken,
        operation: 'clear',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
      });
      recordPublishOutcome(providerId, result);
      return result;
    });
  };

  clearRemoteModels = async (providerId: string) => this.clearModelsByProvider(providerId);

  updateAiModelOrder = async (providerId: string, items: AiModelSortMap[]) => {
    const detail = await getDetail(providerId);
    const mapped = items.map((item) => {
      const found = detail.draft.models.find((m) => m.modelKey === item.id || m.id === item.id);
      if (!found) throw new Error(`Model not found: ${item.id}`);
      return { id: found.id, sort: item.sort };
    });
    const requested = new Set(mapped.map((m) => m.id));
    const complete = [
      ...mapped,
      ...detail.draft.models
        .filter((m) => !requested.has(m.id))
        .map((m, index) => ({ id: m.id, sort: mapped.length + index })),
    ];
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiModels.applyImmediate.mutate({
        expectedDraftToken: detail.draftToken,
        items: complete,
        operation: 'reorder',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
      });
      recordPublishOutcome(providerId, result);
      return result;
    });
  };

  deleteAiModel = async (params: { id: string; providerId: string }) => {
    const { detail, model } = await this.#resolveModelUuid(params.providerId, params.id);
    if (!model) throw new Error(`Model not found: ${params.id}`);
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiModels.applyImmediate.mutate({
        expectedDraftToken: detail.draftToken,
        id: model.id,
        operation: 'delete',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
      });
      recordPublishOutcome(params.providerId, result);
      return result;
    });
  };
}

export const adminAiModelService = new AdminAiModelService();
