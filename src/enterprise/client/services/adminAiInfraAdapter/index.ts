import type {
  AiModelSortMap,
  AiProviderModelListItem,
  CreateAiModelParams,
  ToggleAiModelEnableParams,
  UpdateAiModelParams,
} from 'model-bank';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

import type { AdminAiProviderGetOutput } from '@/enterprise/client/features/admin/ai/types';
import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { lambdaClient } from '@/libs/trpc/client';
import type { GetAiProviderModelListParams } from '@/services/aiModel';
import type {
  AiProviderDetailItem,
  AiProviderListItem,
  AiProviderRuntimeState,
  AiProviderSortMap,
  CreateAiProviderParams,
  UpdateAiProviderConfigParams,
  UpdateAiProviderParams,
} from '@/types/aiProvider';
import { AiProviderSourceEnum } from '@/types/aiProvider';

import { withAdminAiInfraErrorToast } from './errors';
import {
  buildAdminRuntimeState,
  mapModelListItem,
  mapProviderDetail,
  mapProviderListItem,
  splitFormKeyVaults,
} from './mappers';

const DEFAULT_REASON = 'admin provider settings auto-publish';

export type AdminPublishOutcome = {
  providerId: string;
  published: boolean;
  publishError?: string | null;
};

/** Last applyImmediate/publishNow outcome for draft banner (module-level; admin page only). */
let lastPublishOutcome: AdminPublishOutcome | null = null;

export const getLastAdminPublishOutcome = () => lastPublishOutcome;
export const clearLastAdminPublishOutcome = () => {
  lastPublishOutcome = null;
};

const recordPublishOutcome = (
  providerKey: string,
  result: { published?: boolean; publishError?: string | null },
) => {
  lastPublishOutcome = {
    providerId: providerKey,
    published: result.published !== false,
    publishError: result.publishError ?? null,
  };
};

/** Resolve platform UUID from providerKey (user-facing id). */
export const resolveProviderRecord = async (providerKeyOrId: string) => {
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

/** Known built-in provider card (client catalog) used to seed the platform DB lazily. */
const findBuiltinProviderCard = (id: string) =>
  DEFAULT_MODEL_PROVIDER_LIST.find((card) => card.id === id);

/**
 * Resolve the platform detail for a provider, creating the platform DB row on the
 * first write for a known built-in that hasn't been configured yet. Mirrors the user
 * side, where the server auto-inserts the built-in row on read. For unknown providers
 * the original "not found" error is preserved.
 */
const getOrCreateDetail = async (providerKeyOrId: string): Promise<AdminAiProviderGetOutput> => {
  try {
    return await getDetail(providerKeyOrId);
  } catch (cause) {
    const card = findBuiltinProviderCard(providerKeyOrId);
    if (!card) throw cause;
    await adminAiProviderService.createAiProvider({
      description: card.description,
      id: card.id,
      name: card.name,
      settings: card.settings as CreateAiProviderParams['settings'],
      source: AiProviderSourceEnum.Builtin,
    });
    return getDetail(providerKeyOrId);
  }
};

const withReauth = <T>(fn: () => Promise<T>): Promise<T> =>
  withAdminAiInfraErrorToast(() => withAdminReauthRetry(fn));

/**
 * Admin adapter implementing the same surface as user AiProviderService / AiModelService.
 * Writes = draft mutation + immediate publish via applyImmediate.
 * Secrets: merge-only for updates; baseURL maps to public config.endpoint.
 */
export class AdminAiProviderService {
  createAiProvider = async (params: CreateAiProviderParams) => {
    const { endpoint, secretParts } = splitFormKeyVaults(
      params.keyVaults as Record<string, unknown> | undefined,
    );
    const hasSecrets = Object.keys(secretParts).length > 0;
    const config = {
      ...((params.config ?? {}) as Record<string, unknown>),
      ...(endpoint ? { endpoint } : {}),
    };
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiProviders.applyImmediate.mutate({
        config,
        description: params.description ?? null,
        displayName: params.name || params.id,
        logo: params.logo ?? null,
        mode: 'create',
        providerKey: params.id,
        reason: DEFAULT_REASON,
        // First create may use replace (no existing vault).
        secret: hasSecrets
          ? { operation: 'replace' as const, value: secretParts as Record<string, string> }
          : { operation: 'keep' as const },
        settings: (params.settings ?? {}) as Record<string, unknown>,
        source: params.source === AiProviderSourceEnum.Builtin ? 'builtin' : 'custom',
      });
      recordPublishOutcome(params.id, result);
      return result;
    });
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
    // Merge built-in provider catalog so the admin sees every provider the user does.
    // DB rows win by id (providerKey); built-ins without a DB row are appended disabled.
    const dbList = items.map(mapProviderListItem);
    const seen = new Set(dbList.map((provider) => provider.id));
    const builtins = DEFAULT_MODEL_PROVIDER_LIST.filter((card) => !seen.has(card.id)).map(
      (card, index): AiProviderListItem => ({
        description: card.description,
        enabled: false,
        id: card.id,
        name: card.name,
        sort: index,
        source: AiProviderSourceEnum.Builtin,
      }),
    );
    return [...dbList, ...builtins];
  };

  getAiProviderById = async (
    id: string,
  ): Promise<(AiProviderDetailItem & { secretConfigured?: boolean }) | undefined> => {
    try {
      const detail = await getDetail(id);
      return mapProviderDetail(detail);
    } catch {
      // A known built-in without a DB row: return a synthetic detail from the catalog
      // so the form renders (empty credentials) instead of a perpetual skeleton.
      const card = findBuiltinProviderCard(id);
      if (!card) return undefined;
      return {
        description: card.description,
        enabled: false,
        fetchOnClient: false,
        id: card.id,
        keyVaults: {},
        name: card.name,
        secretConfigured: false,
        settings: card.settings,
        source: AiProviderSourceEnum.Builtin,
      };
    }
  };

  toggleProviderEnabled = async (id: string, enabled: boolean) => {
    const detail = await getOrCreateDetail(id);
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiProviders.applyImmediate.mutate({
        enabled,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: detail.draft.id,
        mode: 'update',
        reason: DEFAULT_REASON,
      });
      recordPublishOutcome(id, result);
      return result;
    });
  };

  updateAiProvider = async (id: string, value: UpdateAiProviderParams) => {
    const detail = await getOrCreateDetail(id);
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiProviders.applyImmediate.mutate({
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
      });
      recordPublishOutcome(id, result);
      return result;
    });
  };

  updateAiProviderConfig = async (id: string, value: UpdateAiProviderConfigParams) => {
    const detail = await getOrCreateDetail(id);
    const { endpoint, secretParts } = splitFormKeyVaults(
      value.keyVaults as Record<string, unknown> | undefined,
    );
    const hasSecrets = Object.keys(secretParts).length > 0;

    // Public endpoint: always merge into config when baseURL present (including clear? skip empty).
    const nextConfig: Record<string, unknown> = {
      ...detail.draft.config,
      ...value.config,
    };
    if (endpoint !== undefined) {
      nextConfig.endpoint = endpoint;
    } else if (
      value.keyVaults &&
      Object.prototype.hasOwnProperty.call(value.keyVaults, 'baseURL') &&
      !value.keyVaults.baseURL
    ) {
      // Explicit empty baseURL — leave prior endpoint (do not wipe).
    }

    // Credentials: merge only non-empty fields; never replace whole vault from form.
    const secret = hasSecrets
      ? { operation: 'merge' as const, value: secretParts as Record<string, string> }
      : undefined;

    return withReauth(async () => {
      const result = await lambdaClient.admin.aiProviders.applyImmediate.mutate({
        checkModel: value.checkModel,
        config: nextConfig,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: detail.draft.id,
        mode: 'update',
        reason: DEFAULT_REASON,
        secret,
      });
      recordPublishOutcome(id, result);
      return result;
    });
  };

  updateAiProviderOrder = async (items: AiProviderSortMap[]) => {
    for (const item of items) {
      const detail = await getOrCreateDetail(item.id);
      await withReauth(async () => {
        const result = await lambdaClient.admin.aiProviders.applyImmediate.mutate({
          expectedDraftToken: detail.draftToken,
          expectedRevision: detail.baseRevision,
          id: detail.draft.id,
          mode: 'update',
          reason: DEFAULT_REASON,
          sort: item.sort,
        });
        recordPublishOutcome(item.id, result);
        return result;
      });
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

  /** Banner: retry publish (retest if revision 0). */
  publishNow = async (providerKeyOrId: string) => {
    const detail = await getDetail(providerKeyOrId);
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiProviders.publishNow.mutate({
        id: detail.draft.id,
        reason: DEFAULT_REASON,
      });
      recordPublishOutcome(detail.draft.providerKey, result);
      return result;
    });
  };

  getAiProviderRuntimeState = async (_isLogin?: boolean): Promise<AiProviderRuntimeState> => {
    const list = await lambdaClient.admin.aiProviders.list.query({ limit: 100 });
    const active = list.items.filter((item) => item.status !== 'archived');
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
    return withReauth(async () => {
      const result = await lambdaClient.admin.aiModels.applyImmediate.mutate({
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
      });
      recordPublishOutcome(params.providerId, result);
      return result;
    });
  };

  getAiProviderModelList = async (
    id: string,
    _params?: GetAiProviderModelListParams,
  ): Promise<AiProviderModelListItem[]> => {
    const detail = await getDetail(id);
    return detail.draft.models.map(mapModelListItem);
  };

  getAiModelById = async (id: string) => {
    void id;
    return undefined;
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

export const adminAiProviderService = new AdminAiProviderService();
export const adminAiModelService = new AdminAiModelService();

export const adminAiInfraServices = {
  aiModel: adminAiModelService,
  aiProvider: adminAiProviderService,
  swrScope: 'admin',
} as const;
