import { BRANDING_PROVIDER } from '@lobechat/business-const';
import { buildProviderModelList } from '@lobechat/utils';
import { findBuiltinModelCardPayload } from '@lobechat/utils/builtinModelDefaults';
import type {
  AiModelSortMap,
  AiProviderModelListItem,
  CreateAiModelParams,
  ToggleAiModelEnableParams,
  UpdateAiModelParams,
} from 'model-bank';
import { AiModelSourceEnum, applyChatGPTWebModelPolicy, LOBE_DEFAULT_MODEL_LIST } from 'model-bank';

import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { lambdaClient } from '@/libs/trpc/client';
import type { GetAiProviderModelListParams } from '@/services/aiModel';
import type { UpstreamModelSyncResult } from '@/store/aiInfra/services';

import { mapModelListItem } from './mappers';
import { DEFAULT_REASON, getDetail, isPlatformNotFoundError, withReauth } from './shared';

const normalizeContextWindowTokens = (value: number | null | undefined) =>
  value === 0 ? null : value;

/**
 * Admin adapter for AI model mutations/list — same surface as user AiModelService.
 * Lives in its own module (#49); barrel re-exports from index.ts.
 */
/** One `batchUpdate` item; an `id` with no platform row is an INSERT keyed by modelKey. */
interface ModelBatchUpdateItem {
  abilities?: Record<string, unknown>;
  contextWindowTokens?: number | null;
  description?: string | null;
  displayName?: string | null;
  enabled?: boolean;
  id: string;
  parameters?: Record<string, unknown>;
  pricing?: Record<string, unknown> | null;
  settings?: Record<string, unknown>;
  type?: AiProviderModelListItem['type'];
}

export class AdminAiModelService {
  #resolveModelUuid = async (providerKey: string, modelKeyOrId: string) => {
    const detail = await getDetail(providerKey);
    const model =
      detail.draft.models.find((m) => m.modelKey === modelKeyOrId || m.id === modelKeyOrId) ?? null;
    return { detail, model };
  };

  /**
   * Build the `batchUpdate` item that MATERIALIZES a builtin model's first platform row.
   *
   * The admin model list is a merge of persisted platform rows and the model-bank catalog
   * (`getAiProviderModelList`), so a freshly configured provider shows models that have NO row
   * yet. `batchToggle` is insert-free by construction — it rejects an unknown id — so toggling
   * such a model has to go through `batchUpdate`, whose missing-row branch inserts using
   * `modelKey: item.id` (that branch is gated on AI_MODEL_CREATE, enforced inside the server
   * transaction that decides create-vs-update).
   *
   * The payload is the model-bank card — shared with the server's provider-create seeding via
   * `findBuiltinModelCardPayload`, so a row materialized here and one materialized there carry
   * identical metadata. A key that is in neither the platform rows nor model-bank cannot be
   * described, so it still fails loudly rather than inventing a model.
   */
  #buildMaterializationItem = (
    providerKey: string,
    modelKey: string,
    enabled: boolean,
  ): ModelBatchUpdateItem => {
    const payload = findBuiltinModelCardPayload(providerKey, modelKey);
    if (!payload) throw new Error(`Model not found: ${modelKey}`);
    return {
      abilities: payload.abilities as Record<string, unknown> | undefined,
      contextWindowTokens: payload.contextWindowTokens,
      description: payload.description,
      displayName: payload.displayName,
      enabled,
      id: modelKey,
      parameters: payload.parameters as Record<string, unknown> | undefined,
      pricing: payload.pricing as Record<string, unknown> | null | undefined,
      settings: payload.settings as Record<string, unknown> | undefined,
      type: payload.type as AiProviderModelListItem['type'],
    };
  };

  createAiModel = async (params: CreateAiModelParams) => {
    const detail = await getDetail(params.providerId);
    return withReauth(() =>
      lambdaClient.admin.aiModels.applyImmediate.mutate({
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
      }),
    );
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
      dbModels = detail.draft.models.map((item) => {
        const mapped = mapModelListItem(item);
        const policy = applyChatGPTWebModelPolicy({
          abilities: mapped.abilities,
          modelId: mapped.id,
          providerId: id,
          settings: mapped.settings,
        });
        return { ...mapped, settings: policy.settings };
      });
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
    // Same gap as the batch path: a builtin the admin has never touched has no platform row,
    // and `update` needs one. Materialize it instead of failing the switch.
    if (!model) {
      const item = this.#buildMaterializationItem(
        detail.draft.providerKey,
        params.id,
        params.enabled,
      );
      return withReauth(() =>
        lambdaClient.admin.aiModels.applyImmediate.mutate({
          expectedDraftToken: detail.draftToken,
          models: [item],
          operation: 'batchUpdate',
          providerId: detail.draft.id,
          reason: DEFAULT_REASON,
        }),
      );
    }
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
      }),
    );
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

  /**
   * "Enable all" / "disable all".
   *
   * Splits the requested keys by whether they already have a platform row: existing rows go
   * through `batchToggle` (cheap, insert-free, its own audit action), rows that do not exist yet
   * are materialized through `batchUpdate`. Before this split, a single unmaterialized builtin
   * threw `Model not found` and the whole batch became a no-op — the common case right after a
   * provider is configured, when NO model has a row.
   *
   * Both calls sit under ONE reauth prompt. The second one cannot reuse the first call's
   * `draftToken`: the server derives it from the whole draft (models included) and every
   * applyImmediate republishes, so a stale token is a CAS conflict — the detail is re-read in
   * between, and only in the mixed case that actually needs two calls.
   */
  batchToggleAiModels = async (providerId: string, models: string[], enabled: boolean) => {
    const detail = await getDetail(providerId);
    const existingIds: string[] = [];
    const missingKeys: string[] = [];
    const seen = new Set<string>();
    for (const key of models) {
      if (seen.has(key)) continue;
      seen.add(key);
      const found = detail.draft.models.find((m) => m.modelKey === key || m.id === key);
      if (found) existingIds.push(found.id);
      else missingKeys.push(key);
    }
    // Resolved before any write so an undescribable key fails without half-applying the batch.
    const materialized = missingKeys.map((key) =>
      this.#buildMaterializationItem(detail.draft.providerKey, key, enabled),
    );
    if (existingIds.length === 0 && materialized.length === 0) return;

    return withReauth(async () => {
      let result;
      if (existingIds.length > 0) {
        result = await lambdaClient.admin.aiModels.applyImmediate.mutate({
          enabled,
          expectedDraftToken: detail.draftToken,
          modelIds: existingIds,
          operation: 'batchToggle',
          providerId: detail.draft.id,
          reason: DEFAULT_REASON,
        });
      }
      if (materialized.length > 0) {
        const expectedDraftToken =
          existingIds.length > 0 ? (await getDetail(providerId)).draftToken : detail.draftToken;
        result = await lambdaClient.admin.aiModels.applyImmediate.mutate({
          expectedDraftToken,
          models: materialized,
          operation: 'batchUpdate',
          providerId: detail.draft.id,
          reason: DEFAULT_REASON,
        });
      }
      return result;
    });
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

  clearRemoteModels = async (providerId: string) => this.clearModelsByProvider(providerId);

  /**
   * Enumerate the provider upstream using the SHARED platform account and persist the result.
   *
   * Discovery has to happen server-side: the credential is a platform-vault OAuth account no
   * browser can decrypt, and two of these providers only answer through a process-local
   * transport (curl-impersonate, the `cursor-agent` CLI). The user route is not an option
   * either — it opens the caller's personal vault, and under takeover it replays the published
   * catalog instead of calling upstream at all.
   *
   * `providerId` is the provider key the settings UI addresses everything else by; the server
   * resolves it to the platform row the same way `admin.aiProviders.get` does.
   *
   * Reauth-wrapped but deliberately NOT toast-wrapped: the server distinguishes "this runtime
   * has no enumerator" from an ordinary write failure, and the generic adapter toast cannot say
   * that. The model-list caller renders exactly one message and owns that distinction.
   */
  syncUpstreamModels = async (providerId: string): Promise<UpstreamModelSyncResult> =>
    withAdminReauthRetry(() => lambdaClient.admin.aiModels.syncUpstream.mutate({ providerId }));

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

export const adminAiModelService = new AdminAiModelService();
