import type {
  AiModelSortMap,
  AiProviderModelListItem,
  CreateAiModelParams,
  ToggleAiModelEnableParams,
  UpdateAiModelParams,
} from 'model-bank';

import type { AdminAiProviderGetOutput } from '@/enterprise/client/features/admin/ai/types';
import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { lambdaClient } from '@/libs/trpc/client';
import type { GetAiProviderModelListParams } from '@/services/aiModel';
import type {
  AiProviderDetailItem,
  AiProviderRuntimeState,
  AiProviderSortMap,
  CreateAiProviderParams,
  UpdateAiProviderConfigParams,
  UpdateAiProviderParams,
} from '@/types/aiProvider';
import { AiProviderSourceEnum } from '@/types/aiProvider';

import {
  buildAdminRuntimeState,
  mapModelListItem,
  mapProviderDetail,
  mapProviderListItem,
} from './mappers';

const DEFAULT_REASON = 'admin provider settings auto-publish';

/** Resolve platform UUID from providerKey (user-facing id). */
const resolveProviderRecord = async (providerKeyOrId: string) => {
  // Prefer exact key match via list (paginated).
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await lambdaClient.admin.aiProviders.list.query({
      cursor,
      limit: 100,
    });
    const hit = result.items.find(
      (item) => item.providerKey === providerKeyOrId || item.id === providerKeyOrId,
    );
    if (hit) return hit;
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  throw new Error(`Platform provider not found: ${providerKeyOrId}`);
};

const getDetail = async (providerKeyOrId: string): Promise<AdminAiProviderGetOutput> => {
  const record = await resolveProviderRecord(providerKeyOrId);
  return lambdaClient.admin.aiProviders.get.query({ id: record.id });
};

const withReauth = <T>(fn: () => Promise<T>): Promise<T> => withAdminReauthRetry(fn);

/**
 * Admin adapter implementing the same surface as user AiProviderService / AiModelService.
 * All writes = draft mutation + immediate publish via applyImmediate procedures.
 * Secrets never leave the server as plaintext.
 */
export class AdminAiProviderService {
  createAiProvider = async (params: CreateAiProviderParams) => {
    const keyVaults = (params.keyVaults ?? {}) as Record<string, string>;
    const hasVaults = Object.keys(keyVaults).length > 0;
    // Structured secret keeps apiKey + baseURL (+ other provider fields) together —
    // never drop baseURL when apiKey is present.
    return withReauth(() =>
      lambdaClient.admin.aiProviders.applyImmediate.mutate({
        config: (params.config ?? {}) as Record<string, unknown>,
        description: params.description ?? null,
        displayName: params.name || params.id,
        logo: params.logo ?? null,
        mode: 'create',
        providerKey: params.id,
        reason: DEFAULT_REASON,
        secret: hasVaults
          ? {
              operation: 'replace' as const,
              value: keyVaults,
            }
          : { operation: 'keep' as const },
        settings: (params.settings ?? {}) as Record<string, unknown>,
        source: params.source === AiProviderSourceEnum.Builtin ? 'builtin' : 'custom',
      }),
    );
  };

  getAiProviderList = async () => {
    const items = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await lambdaClient.admin.aiProviders.list.query({
        cursor,
        limit: 100,
      });
      items.push(...result.items.filter((item) => item.status !== 'archived'));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return items.map(mapProviderListItem);
  };

  getAiProviderById = async (
    id: string,
  ): Promise<(AiProviderDetailItem & { secretConfigured?: boolean }) | undefined> => {
    try {
      const detail = await getDetail(id);
      return mapProviderDetail(detail);
    } catch {
      return undefined;
    }
  };

  toggleProviderEnabled = async (id: string, enabled: boolean) => {
    const detail = await getDetail(id);
    return withReauth(() =>
      lambdaClient.admin.aiProviders.applyImmediate.mutate({
        enabled,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: detail.draft.id,
        mode: 'update',
        reason: DEFAULT_REASON,
      }),
    );
  };

  updateAiProvider = async (id: string, value: UpdateAiProviderParams) => {
    const detail = await getDetail(id);
    return withReauth(() =>
      lambdaClient.admin.aiProviders.applyImmediate.mutate({
        description: value.description === null ? null : (value.description ?? undefined),
        displayName: value.name,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: detail.draft.id,
        logo: value.logo === null ? null : (value.logo ?? undefined),
        mode: 'update',
        reason: DEFAULT_REASON,
        settings: value.settings
          ? ({ ...detail.draft.settings, ...value.settings } as Record<string, unknown>)
          : undefined,
      }),
    );
  };

  updateAiProviderConfig = async (id: string, value: UpdateAiProviderConfigParams) => {
    const detail = await getDetail(id);
    const secretFields = value.keyVaults
      ? Object.entries(value.keyVaults).filter(([, v]) => typeof v === 'string' && v.length > 0)
      : [];
    const hasSecretUpdate = secretFields.length > 0;

    // Strip empty key vault entries (admin "Configured" placeholder — do not clear secret).
    const secret = hasSecretUpdate
      ? {
          operation: 'replace' as const,
          value:
            secretFields.length === 1 && secretFields[0][0] === 'apiKey'
              ? (secretFields[0][1] as string)
              : (Object.fromEntries(secretFields) as Record<string, string>),
        }
      : undefined;

    return withReauth(() =>
      lambdaClient.admin.aiProviders.applyImmediate.mutate({
        checkModel: value.checkModel,
        config: value.config
          ? ({ ...detail.draft.config, ...value.config } as Record<string, unknown>)
          : undefined,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        // fetchOnClient has no global platform equivalent — ignore silently with no client switch.
        id: detail.draft.id,
        mode: 'update',
        reason: DEFAULT_REASON,
        secret,
      }),
    );
  };

  updateAiProviderOrder = async (items: AiProviderSortMap[]) => {
    // Sequential applies; each is one rate-limit unit. Prefer bulk later if needed.
    for (const item of items) {
      const detail = await getDetail(item.id);
      await withReauth(() =>
        lambdaClient.admin.aiProviders.applyImmediate.mutate({
          expectedDraftToken: detail.draftToken,
          expectedRevision: detail.baseRevision,
          id: detail.draft.id,
          mode: 'update',
          reason: DEFAULT_REASON,
          sort: item.sort,
        }),
      );
    }
  };

  deleteAiProvider = async (id: string) => {
    const detail = await getDetail(id);
    return withReauth(() =>
      lambdaClient.admin.aiProviders.archive.mutate({
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: detail.draft.id,
        reason: DEFAULT_REASON,
      }),
    );
  };

  getAiProviderRuntimeState = async (_isLogin?: boolean): Promise<AiProviderRuntimeState> => {
    const list = await lambdaClient.admin.aiProviders.list.query({ limit: 100 });
    const active = list.items.filter((item) => item.status !== 'archived');
    // Paginate remaining if needed
    let cursor = list.nextCursor;
    while (cursor) {
      const page = await lambdaClient.admin.aiProviders.list.query({ cursor, limit: 100 });
      active.push(...page.items.filter((item) => item.status !== 'archived'));
      cursor = page.nextCursor;
    }

    const modelsByKey = new Map<string, AdminAiProviderGetOutput['draft']['models']>();
    await Promise.all(
      active.map(async (provider) => {
        try {
          const detail = await lambdaClient.admin.aiProviders.get.query({ id: provider.id });
          modelsByKey.set(provider.providerKey, detail.draft.models);
        } catch {
          modelsByKey.set(provider.providerKey, []);
        }
      }),
    );

    return buildAdminRuntimeState(active, modelsByKey);
  };
}

export class AdminAiModelService {
  #resolveModelUuid = async (providerKey: string, modelKeyOrId: string) => {
    const detail = await getDetail(providerKey);
    const model =
      detail.draft.models.find((m) => m.modelKey === modelKeyOrId || m.id === modelKeyOrId) ?? null;
    return { detail, model };
  };

  createAiModel = async (params: CreateAiModelParams) => {
    const detail = await getDetail(params.providerId);
    return withReauth(() =>
      lambdaClient.admin.aiModels.applyImmediate.mutate({
        abilities: params.abilities as Record<string, unknown> | undefined,
        contextWindowTokens: params.contextWindowTokens ?? null,
        displayName: params.displayName ?? null,
        enabled: true,
        expectedDraftToken: detail.draftToken,
        modelKey: params.id,
        operation: 'create',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
        settings: params.settings as Record<string, unknown> | undefined,
        type: params.type ?? 'chat',
      }),
    );
  };

  getAiProviderModelList = async (
    id: string,
    _params?: GetAiProviderModelListParams,
  ): Promise<AiProviderModelListItem[]> => {
    const detail = await getDetail(id);
    return detail.draft.models.map(mapModelListItem);
  };

  getAiModelById = async (id: string) => {
    // Platform models are scoped by provider; id alone is not enough.
    // Store rarely calls this; return undefined rather than guessing.
    void id;
    return undefined;
  };

  toggleModelEnabled = async (params: ToggleAiModelEnableParams) => {
    const { detail, model } = await this.#resolveModelUuid(params.providerId, params.id);
    if (!model) throw new Error(`Model not found: ${params.id}`);
    return withReauth(() =>
      lambdaClient.admin.aiModels.applyImmediate.mutate({
        enabled: params.enabled,
        expectedDraftToken: detail.draftToken,
        expectedRevision: model.revision,
        id: model.id,
        operation: 'update',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
      }),
    );
  };

  updateAiModel = async (id: string, providerId: string, value: UpdateAiModelParams) => {
    const { detail, model } = await this.#resolveModelUuid(providerId, id);
    if (!model) throw new Error(`Model not found: ${id}`);
    return withReauth(() =>
      lambdaClient.admin.aiModels.applyImmediate.mutate({
        abilities: value.abilities as Record<string, unknown> | undefined,
        config: value.config as Record<string, unknown> | null | undefined,
        contextWindowTokens: value.contextWindowTokens ?? undefined,
        displayName: value.displayName ?? undefined,
        expectedDraftToken: detail.draftToken,
        expectedRevision: model.revision,
        id: model.id,
        operation: 'update',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
        settings: value.settings as Record<string, unknown> | undefined,
        type: value.type,
      }),
    );
  };

  batchUpdateAiModels = async (providerId: string, models: AiProviderModelListItem[]) => {
    const detail = await getDetail(providerId);
    // Map modelKey ids to platform uuid when present
    const mapped = models.map((m) => {
      const existing = detail.draft.models.find((d) => d.modelKey === m.id || d.id === m.id);
      return {
        abilities: m.abilities as Record<string, unknown> | undefined,
        config: m.config as Record<string, unknown> | null | undefined,
        contextWindowTokens: m.contextWindowTokens ?? null,
        displayName: m.displayName ?? null,
        enabled: m.enabled,
        id: existing?.id ?? m.id,
        parameters: m.parameters as Record<string, unknown> | undefined,
        pricing: m.pricing as Record<string, unknown> | null | undefined,
        settings: m.settings as Record<string, unknown> | undefined,
        type: m.type,
      };
    });
    return withReauth(() =>
      lambdaClient.admin.aiModels.applyImmediate.mutate({
        expectedDraftToken: detail.draftToken,
        models: mapped,
        operation: 'batchUpdate',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
      }),
    );
  };

  batchToggleAiModels = async (providerId: string, models: string[], enabled: boolean) => {
    const detail = await getDetail(providerId);
    const modelIds = models.map((key) => {
      const found = detail.draft.models.find((m) => m.modelKey === key || m.id === key);
      if (!found) throw new Error(`Model not found: ${key}`);
      return found.id;
    });
    return withReauth(() =>
      lambdaClient.admin.aiModels.applyImmediate.mutate({
        enabled,
        expectedDraftToken: detail.draftToken,
        modelIds,
        operation: 'batchToggle',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
      }),
    );
  };

  clearModelsByProvider = async (providerId: string) => {
    const detail = await getDetail(providerId);
    return withReauth(() =>
      lambdaClient.admin.aiModels.applyImmediate.mutate({
        expectedDraftToken: detail.draftToken,
        operation: 'clear',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
      }),
    );
  };

  clearRemoteModels = async (providerId: string) => {
    // Platform catalog has no remote/local model split — clear all models.
    return this.clearModelsByProvider(providerId);
  };

  updateAiModelOrder = async (providerId: string, items: AiModelSortMap[]) => {
    const detail = await getDetail(providerId);
    const mapped = items.map((item) => {
      const found = detail.draft.models.find((m) => m.modelKey === item.id || m.id === item.id);
      if (!found) throw new Error(`Model not found: ${item.id}`);
      return { id: found.id, sort: item.sort };
    });
    // Reorder requires complete collection — merge unlisted models at end
    const requested = new Set(mapped.map((m) => m.id));
    const complete = [
      ...mapped,
      ...detail.draft.models
        .filter((m) => !requested.has(m.id))
        .map((m, index) => ({ id: m.id, sort: mapped.length + index })),
    ];
    return withReauth(() =>
      lambdaClient.admin.aiModels.applyImmediate.mutate({
        expectedDraftToken: detail.draftToken,
        items: complete,
        operation: 'reorder',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
      }),
    );
  };

  deleteAiModel = async (params: { id: string; providerId: string }) => {
    const { detail, model } = await this.#resolveModelUuid(params.providerId, params.id);
    if (!model) throw new Error(`Model not found: ${params.id}`);
    return withReauth(() =>
      lambdaClient.admin.aiModels.applyImmediate.mutate({
        expectedDraftToken: detail.draftToken,
        id: model.id,
        operation: 'delete',
        providerId: detail.draft.id,
        reason: DEFAULT_REASON,
      }),
    );
  };
}

export const adminAiProviderService = new AdminAiProviderService();
export const adminAiModelService = new AdminAiModelService();

export const adminAiInfraServices = {
  aiModel: adminAiModelService,
  aiProvider: adminAiProviderService,
  swrScope: 'admin',
} as const;
