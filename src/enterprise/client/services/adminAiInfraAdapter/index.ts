import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

import type { AdminAiProviderGetOutput } from '@/enterprise/client/features/admin/ai/types';
import { lambdaClient } from '@/libs/trpc/client';
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

import { adminAiModelService } from './AdminAiModelService';
import { createAdminAiProviderPartialLoadError } from './errors';
import {
  buildAdminRuntimeState,
  mapProviderDetail,
  mapProviderListItem,
  splitFormKeyVaults,
} from './mappers';
import {
  createGetOrCreateDetail,
  DEFAULT_REASON,
  findBuiltinProviderCard,
  getDetail,
  isPlatformNotFoundError,
  recordPublishOutcome,
  withReauth,
} from './shared';

export { AdminAiModelService, adminAiModelService } from './AdminAiModelService';
export {
  createAdminAiProviderPartialLoadError,
  isAdminAiInfraErrorToasted,
  withAdminAiInfraErrorToast,
} from './errors';
export type { AdminPublishOutcome } from './shared';
export { clearLastAdminPublishOutcome, useAdminPublishOutcome } from './shared';

export interface AdminAiProviderOrderPublishFailure {
  providerId: string;
  publishError: string | null;
}

export class AdminAiProviderOrderPublishError extends Error {
  code = 'ADMIN_AI_PROVIDER_ORDER_PARTIAL_PUBLISH' as const;

  constructor(public failures: AdminAiProviderOrderPublishFailure[]) {
    super('ADMIN_AI_PROVIDER_ORDER_PARTIAL_PUBLISH');
    this.name = 'AdminAiProviderOrderPublishError';
  }
}

/**
 * Admin adapter implementing the same surface as user AiProviderService.
 * Writes = draft mutation + immediate publish via applyImmediate.
 * Secrets: merge-only for updates; baseURL maps to public config.endpoint.
 */
export class AdminAiProviderService {
  #getOrCreateDetail = createGetOrCreateDetail((params) => this.createAiProvider(params));

  createAiProvider = async (params: CreateAiProviderParams) => {
    const { endpoint, secretParts } = splitFormKeyVaults(
      params.keyVaults as Record<string, unknown> | undefined,
    );
    const hasSecrets = Object.keys(secretParts).length > 0;
    const config = {
      ...((params.config ?? {}) as Record<string, unknown>),
      ...(typeof endpoint === 'string' ? { endpoint } : {}),
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
    } catch (cause) {
      // Only absent platform rows fall back to a synthetic built-in; other failures rethrow.
      if (!isPlatformNotFoundError(cause)) throw cause;
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
    const detail = await this.#getOrCreateDetail(id);
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
    const detail = await this.#getOrCreateDetail(id);
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
    const detail = await this.#getOrCreateDetail(id);
    const { endpoint, secretParts } = splitFormKeyVaults(
      value.keyVaults as Record<string, unknown> | undefined,
    );
    const hasSecrets = Object.keys(secretParts).length > 0;

    // Public endpoint tri-state: set string / clear null / absent undefined.
    const nextConfig: Record<string, unknown> = {
      ...detail.draft.config,
      ...value.config,
    };
    if (typeof endpoint === 'string') {
      nextConfig.endpoint = endpoint;
    } else if (endpoint === null) {
      // Explicit empty baseURL — remove stored endpoint so default applies.
      delete nextConfig.endpoint;
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

  /**
   * Reorder providers.
   *
   * Intentionally sequential applyImmediate (not a multi-provider batch endpoint):
   * each provider has independent draftToken/revision CAS and may auto-publish with
   * side effects. A multi-resource batch would need multi-CAS + partial-failure /
   * multi-publish atomicity that the current revision model does not offer safely.
   * (Per-provider model reorder is already a single complete-set endpoint.)
   *
   * Resolves all provider details once (O(M) providerKey lookups, no full-list scan),
   * then applies sort mutations sequentially under reauth.
   */
  updateAiProviderOrder = async (items: AiProviderSortMap[]) => {
    const details = await Promise.all(
      items.map(async (item) => ({
        detail: await this.#getOrCreateDetail(item.id),
        item,
      })),
    );
    const failures: AdminAiProviderOrderPublishFailure[] = [];
    for (const { detail, item } of details) {
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
        if (result.published === false) {
          failures.push({
            providerId: item.id,
            publishError: result.publishError ?? null,
          });
        }
        return result;
      });
    }
    if (failures.length > 0) throw new AdminAiProviderOrderPublishError(failures);
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

  /**
   * Runtime state for ModelList / EnableSwitch.
   * One list pagination + one getBatch for active providers (no per-provider N+1).
   */
  getAiProviderRuntimeState = async (_isLogin?: boolean): Promise<AiProviderRuntimeState> => {
    const active = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const pageResult = await lambdaClient.admin.aiProviders.list.query({
        cursor,
        limit: 100,
      });
      active.push(...pageResult.items.filter((item) => item.status !== 'archived'));
      if (!pageResult.nextCursor) break;
      cursor = pageResult.nextCursor;
    }

    const modelsByKey = new Map<string, AdminAiProviderGetOutput['draft']['models']>();
    const failedIds: string[] = [];
    const failedProviderKeys: string[] = [];

    if (active.length > 0) {
      // Chunk to honor getBatch max 100 ids.
      for (let offset = 0; offset < active.length; offset += 100) {
        const chunk = active.slice(offset, offset + 100);
        const batch = await lambdaClient.admin.aiProviders.getBatch.query({
          ids: chunk.map((provider) => provider.id),
        });
        const receivedIds = new Set(batch.items.map((detail) => detail.draft.id));
        for (const detail of batch.items) {
          modelsByKey.set(detail.draft.providerKey, detail.draft.models);
        }
        if (Array.isArray(batch.failedIds)) failedIds.push(...batch.failedIds);
        if (Array.isArray(batch.failedProviderKeys)) {
          failedProviderKeys.push(...batch.failedProviderKeys);
        }
        // Any requested id neither returned nor listed as failed is also a partial failure —
        // do not treat the missing row as an authoritative empty model catalog.
        for (const provider of chunk) {
          if (
            !receivedIds.has(provider.id) &&
            !batch.failedIds?.includes(provider.id) &&
            !batch.failedProviderKeys?.includes(provider.providerKey)
          ) {
            failedIds.push(provider.id);
            failedProviderKeys.push(provider.providerKey);
          }
        }
      }
    }

    if (failedIds.length > 0 || failedProviderKeys.length > 0) {
      // Prefer providerKeys for UX/details; fall back to ids when only ids failed.
      const uniqueFailed = [...new Set([...failedProviderKeys, ...failedIds])];
      throw createAdminAiProviderPartialLoadError(uniqueFailed);
    }

    // Only seed empty model arrays after confirming every provider detail loaded.
    for (const provider of active) {
      if (!modelsByKey.has(provider.providerKey)) {
        modelsByKey.set(provider.providerKey, []);
      }
    }

    return buildAdminRuntimeState(active, modelsByKey);
  };
}

export const adminAiProviderService = new AdminAiProviderService();

export const adminAiInfraServices = {
  aiModel: adminAiModelService,
  aiProvider: adminAiProviderService,
  swrScope: 'admin',
} as const;
