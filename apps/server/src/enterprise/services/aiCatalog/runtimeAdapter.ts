import type { ModelRuntimeHooks } from '@lobechat/model-runtime';
import type {
  AiProviderRuntimeConfig,
  AiProviderRuntimeState,
  EnabledProvider,
} from '@lobechat/types';
import { isRecord } from '@lobechat/utils/object';
import type { EnabledAiModel, ModelSearchImplementType } from 'model-bank';
import { LOBE_DEFAULT_MODEL_LIST } from 'model-bank';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type {
  PlatformAiProviderConfig,
  PlatformAiProviderSettings,
  PlatformResourceRevisionItem,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { type PlatformSecretService, secretNotReadable } from '../../security/secret';
import type { CurrentAiCatalogSnapshot } from '../platformInstance/catalogAuthority';
import { loadCurrentAiCatalogSnapshot } from '../platformInstance/catalogAuthority';
import type { PlatformRuntimeMaterializationReporter } from '../platformInstance/runtimeReporter';
import {
  classifyRuntimeMaterializationError,
  reportPlatformRuntimeMaterialization,
  reportPlatformRuntimeMaterializationSafely,
} from '../platformInstance/runtimeReporter';
import { normalizeAiCatalogExecutionCredentials } from './credentialAdapter';
import {
  AiCatalogModelNotPublishedError,
  AiCatalogNotFoundError,
  AiCatalogProviderDisabledError,
} from './errors';
import type { PlatformProviderKeyVaults } from './secretManager';
import { AiCatalogSecretManager } from './secretManager';

/**
 * Credential-free provider config fields safe to expose in public runtime state.
 * Endpoints, headers, and secrets stay server-only (execution resolver path).
 */
export const projectPublicAiProviderRuntimeConfig = (
  config: unknown,
): AiProviderRuntimeConfig['config'] => {
  if (!isRecord(config)) return {};
  const projected: AiProviderRuntimeConfig['config'] = {};
  if (typeof config.enableResponseApi === 'boolean') {
    projected.enableResponseApi = config.enableResponseApi;
  }
  return projected;
};

const EMPTY_RUNTIME_STATE: AiProviderRuntimeState = {
  enabledAiModels: [],
  enabledAiProviders: [],
  enabledChatAiProviders: [],
  enabledImageAiProviders: [],
  enabledVideoAiProviders: [],
  runtimeConfig: {},
};

export interface AiCatalogShadowComparison {
  differencesTruncated: boolean;
  managedModelCount: number;
  managedProviderCount: number;
  modelOnlyInManaged: string[];
  modelOnlyInManagedTotal: number;
  modelOnlyInUpstream: string[];
  modelOnlyInUpstreamTotal: number;
  providerOnlyInManaged: string[];
  providerOnlyInManagedTotal: number;
  providerOnlyInUpstream: string[];
  providerOnlyInUpstreamTotal: number;
  upstreamModelCount: number;
  upstreamProviderCount: number;
}

export const recordAiCatalogShadowComparison = (
  upstream: AiProviderRuntimeState,
  managed: AiProviderRuntimeState,
): AiCatalogShadowComparison => compareAiCatalogRuntimeStates(upstream, managed);

const MAX_SHADOW_DIFFERENCE_ITEMS = 100;

const boundedDifference = (left: Set<string>, right: Set<string>) => {
  const all = [...left].filter((item) => !right.has(item)).sort();
  return { items: all.slice(0, MAX_SHADOW_DIFFERENCE_ITEMS), total: all.length };
};

export const compareAiCatalogRuntimeStates = (
  upstream: AiProviderRuntimeState,
  managed: AiProviderRuntimeState,
): AiCatalogShadowComparison => {
  const upstreamProviders = new Set(upstream.enabledAiProviders.map((provider) => provider.id));
  const managedProviders = new Set(managed.enabledAiProviders.map((provider) => provider.id));
  const upstreamModels = new Set(
    upstream.enabledAiModels.map((model) => `${model.providerId}:${model.id}`),
  );
  const managedModels = new Set(
    managed.enabledAiModels.map((model) => `${model.providerId}:${model.id}`),
  );
  const modelOnlyInManaged = boundedDifference(managedModels, upstreamModels);
  const modelOnlyInUpstream = boundedDifference(upstreamModels, managedModels);
  const providerOnlyInManaged = boundedDifference(managedProviders, upstreamProviders);
  const providerOnlyInUpstream = boundedDifference(upstreamProviders, managedProviders);
  return {
    differencesTruncated: [
      modelOnlyInManaged,
      modelOnlyInUpstream,
      providerOnlyInManaged,
      providerOnlyInUpstream,
    ].some((difference) => difference.total > difference.items.length),
    managedModelCount: managedModels.size,
    managedProviderCount: managedProviders.size,
    modelOnlyInManaged: modelOnlyInManaged.items,
    modelOnlyInManagedTotal: modelOnlyInManaged.total,
    modelOnlyInUpstream: modelOnlyInUpstream.items,
    modelOnlyInUpstreamTotal: modelOnlyInUpstream.total,
    providerOnlyInManaged: providerOnlyInManaged.items,
    providerOnlyInManagedTotal: providerOnlyInManaged.total,
    providerOnlyInUpstream: providerOnlyInUpstream.items,
    providerOnlyInUpstreamTotal: providerOnlyInUpstream.total,
    upstreamModelCount: upstreamModels.size,
    upstreamProviderCount: upstreamProviders.size,
  };
};

const runtimeCache = new Map<string, AiProviderRuntimeState>();
const MAX_RUNTIME_CACHE_ENTRIES = 20;
let activeRuntimeLoad: { generation: number; promise: Promise<AiProviderRuntimeState> } | undefined;
let runtimeCacheGeneration = 0;
const builtinModelMap = new Map(
  LOBE_DEFAULT_MODEL_LIST.map((model) => [`${model.providerId}:${model.id}`, model]),
);

const hasPublishedMetadata = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).length > 0;

const cacheState = (key: string, state: AiProviderRuntimeState): AiProviderRuntimeState => {
  runtimeCache.set(key, state);
  while (runtimeCache.size > MAX_RUNTIME_CACHE_ENTRIES) {
    const oldest = runtimeCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    runtimeCache.delete(oldest);
  }
  return state;
};

export const clearAiCatalogRuntimeCache = (): void => {
  activeRuntimeLoad = undefined;
  runtimeCacheGeneration += 1;
  runtimeCache.clear();
};

export interface AiCatalogRuntimeAdapterOptions {
  loadCurrentSnapshot?: () => Promise<CurrentAiCatalogSnapshot>;
  reportRuntimeState?: PlatformRuntimeMaterializationReporter;
}

export class AiCatalogRuntimeAdapter {
  private readonly loadCurrentSnapshot: () => Promise<CurrentAiCatalogSnapshot>;
  private readonly reportRuntimeState: PlatformRuntimeMaterializationReporter;

  constructor(
    private readonly db: LobeChatDatabase,
    options: AiCatalogRuntimeAdapterOptions = {},
  ) {
    this.loadCurrentSnapshot =
      options.loadCurrentSnapshot ?? (() => loadCurrentAiCatalogSnapshot(this.db));
    this.reportRuntimeState = options.reportRuntimeState ?? reportPlatformRuntimeMaterialization;
  }

  resolve = async (params: {
    flags?: EnterpriseFeatureFlags;
    upstreamState: AiProviderRuntimeState;
  }): Promise<AiProviderRuntimeState> => {
    const flags = params.flags ?? parseEnterpriseFeatureFlags(process.env);
    // Exact rollback compatibility: no catalog DB read, decrypt, or cache access.
    if (!flags.ENABLE_PLATFORM_MANAGED_AI) return params.upstreamState;

    const current = activeRuntimeLoad;
    if (current?.generation === runtimeCacheGeneration) return current.promise;

    const generation = runtimeCacheGeneration;
    const promise = this.loadRuntimeState(generation);
    const flight = { generation, promise };
    activeRuntimeLoad = flight;
    try {
      return await promise;
    } finally {
      if (activeRuntimeLoad === flight) activeRuntimeLoad = undefined;
    }
  };

  private loadRuntimeState = async (generation: number): Promise<AiProviderRuntimeState> => {
    try {
      const { revisions, token } = await this.loadCurrentSnapshot();
      const cacheKey = token.value;
      const cached = runtimeCache.get(cacheKey);
      if (cached) return cached;

      const sortedProviders: Array<{ provider: EnabledProvider; sort: number }> = [];
      const models: EnabledAiModel[] = [];
      const runtimeConfig: Record<string, AiProviderRuntimeConfig> = {};

      for (const revision of revisions) {
        if (!isRecord(revision.payload.provider) || !Array.isArray(revision.payload.models))
          continue;
        const provider = revision.payload.provider;
        if (
          provider.enabled !== true ||
          typeof provider.providerKey !== 'string' ||
          typeof provider.displayName !== 'string'
        ) {
          continue;
        }
        const providerKey = provider.providerKey;
        sortedProviders.push({
          provider: {
            id: providerKey,
            logo: typeof provider.logo === 'string' ? provider.logo : undefined,
            name: provider.displayName,
            source: provider.source === 'builtin' ? 'builtin' : 'custom',
          },
          sort: typeof provider.sort === 'number' ? provider.sort : Number.MAX_SAFE_INTEGER,
        });
        runtimeConfig[providerKey] = {
          config: projectPublicAiProviderRuntimeConfig(provider.config),
          fetchOnClient: false,
          keyVaults: {},
          settings: {},
        };

        for (const rawModel of revision.payload.models) {
          if (
            !isRecord(rawModel) ||
            rawModel.enabled !== true ||
            typeof rawModel.modelKey !== 'string'
          ) {
            continue;
          }
          const builtin = builtinModelMap.get(`${providerKey}:${rawModel.modelKey}`);
          const publishedConfig = isRecord(rawModel.config) ? rawModel.config : {};
          const deploymentName =
            typeof publishedConfig.deploymentName === 'string'
              ? publishedConfig.deploymentName
              : undefined;
          models.push({
            ...builtin,
            abilities: hasPublishedMetadata(rawModel.abilities)
              ? rawModel.abilities
              : (builtin?.abilities ?? {}),
            config: {
              ...builtin?.config,
              ...(deploymentName ? { deploymentName } : {}),
            },
            contextWindowTokens:
              typeof rawModel.contextWindowTokens === 'number'
                ? rawModel.contextWindowTokens
                : builtin?.contextWindowTokens,
            description:
              typeof rawModel.description === 'string'
                ? rawModel.description
                : builtin?.description,
            displayName:
              typeof rawModel.displayName === 'string'
                ? rawModel.displayName
                : builtin?.displayName,
            enabled: true,
            id: rawModel.modelKey,
            parameters: hasPublishedMetadata(rawModel.parameters)
              ? rawModel.parameters
              : builtin?.parameters,
            pricing: hasPublishedMetadata(rawModel.pricing) ? rawModel.pricing : builtin?.pricing,
            providerId: providerKey,
            settings: hasPublishedMetadata(rawModel.settings)
              ? rawModel.settings
              : builtin?.settings,
            sort: typeof rawModel.sort === 'number' ? rawModel.sort : undefined,
            source: builtin ? 'builtin' : 'custom',
            type: typeof rawModel.type === 'string' ? rawModel.type : 'chat',
          } as EnabledAiModel);
        }
      }

      sortedProviders.sort((a, b) => a.sort - b.sort || a.provider.id.localeCompare(b.provider.id));
      const providers = sortedProviders.map(({ provider }) => provider);
      models.sort(
        (a, b) =>
          (a.sort ?? Number.MAX_SAFE_INTEGER) - (b.sort ?? Number.MAX_SAFE_INTEGER) ||
          a.providerId.localeCompare(b.providerId) ||
          a.id.localeCompare(b.id),
      );
      const providerHasType = (provider: EnabledProvider, type: string) =>
        models.some((model) => model.providerId === provider.id && model.type === type);
      const state = {
        enabledAiModels: models,
        enabledAiProviders: providers,
        enabledChatAiProviders: providers.filter((provider) => providerHasType(provider, 'chat')),
        enabledImageAiProviders: providers.filter((provider) => providerHasType(provider, 'image')),
        enabledVideoAiProviders: providers.filter((provider) => providerHasType(provider, 'video')),
        runtimeConfig,
      } satisfies AiProviderRuntimeState;
      if (generation !== runtimeCacheGeneration) return state;

      const materialized = cacheState(cacheKey, state);
      reportPlatformRuntimeMaterializationSafely(this.reportRuntimeState, this.db, {
        domain: 'ai_catalog',
        health: 'healthy',
        revisionId: token.value,
        source: 'database',
      });
      return materialized;
    } catch (error) {
      if (generation === runtimeCacheGeneration) {
        activeRuntimeLoad = undefined;
        runtimeCache.clear();
        runtimeCacheGeneration += 1;
        reportPlatformRuntimeMaterializationSafely(this.reportRuntimeState, this.db, {
          domain: 'ai_catalog',
          errorCategory: classifyRuntimeMaterializationError(error),
          health: 'unavailable',
          source: 'unavailable',
        });
      }
      throw error;
    }
  };
}

export interface AiCatalogProviderExecutionConfig {
  allowedModels: AiCatalogPublishedExecutionModel[];
  config: Record<string, unknown>;
  keyVaults: PlatformProviderKeyVaults;
  providerKey: string;
  revision: number;
  runtimeProvider: string;
}

export interface AiCatalogPublishedExecutionModel {
  abilities?: { search?: boolean };
  modelKey: string;
  settings?: { searchImpl?: ModelSearchImplementType };
  type: string;
}

const assertPublishedModel = async (
  allowedModels: AiCatalogPublishedExecutionModel[],
  model: string,
  expectedType: string,
  operation: string,
): Promise<void> => {
  const allowed = allowedModels.some(
    (item) => item.modelKey === model && item.type === expectedType,
  );
  if (!allowed) throw new AiCatalogModelNotPublishedError(model, operation);
};

/** Fail-closed allowlist guard composed before all provider/network hooks. */
export const createAiCatalogModelAllowlistHooks = (
  allowedModels: AiCatalogPublishedExecutionModel[],
): ModelRuntimeHooks => ({
  beforeChat: (payload) => assertPublishedModel(allowedModels, payload.model, 'chat', 'chat'),
  beforeCreateImage: (payload) =>
    assertPublishedModel(allowedModels, payload.model, 'image', 'createImage'),
  beforeCreateVideo: (payload) =>
    assertPublishedModel(allowedModels, payload.model, 'video', 'createVideo'),
  beforeEmbeddings: (payload) =>
    assertPublishedModel(allowedModels, payload.model, 'embedding', 'embeddings'),
  beforeGenerateObject: (payload) =>
    assertPublishedModel(allowedModels, payload.model, 'chat', 'generateObject'),
  beforeTextToSpeech: (payload) =>
    assertPublishedModel(allowedModels, payload.model, 'tts', 'textToSpeech'),
  beforeTranscribe: (payload) =>
    assertPublishedModel(allowedModels, payload.model, 'asr', 'transcribe'),
});

/** Server-only resolver. Plaintext is returned for one execution and is never cached. */
export class AiCatalogExecutionResolver {
  private readonly db: LobeChatDatabase;
  private readonly secrets: AiCatalogSecretManager;

  constructor(db: LobeChatDatabase, secretService: PlatformSecretService) {
    this.db = db;
    this.secrets = new AiCatalogSecretManager(secretService);
  }

  async resolveProviderExecutionConfig(
    providerKey: string,
  ): Promise<AiCatalogProviderExecutionConfig> {
    const repository = new PlatformAiCatalogRepository(this.db);
    const { revisions } = await loadCurrentAiCatalogSnapshot(this.db);
    const revision = revisions.find(
      (item) =>
        isRecord(item.payload.provider) && item.payload.provider.providerKey === providerKey,
    );
    if (!revision || !isRecord(revision.payload.provider)) {
      // Snapshot omits archived pointers. A known provider with a non-zero pointer was once
      // published and is now inactive — fail closed so runtime does not resurrect it via BYOK.
      const known = await repository.getProviderByKey(providerKey);
      if (known && known.revision > 0) {
        throw new AiCatalogProviderDisabledError(providerKey);
      }
      throw new AiCatalogNotFoundError();
    }
    return this.buildExecutionConfigFromRevision(providerKey, revision, repository);
  }

  /**
   * Resolve the provider execution config at an EXACT historical published revision (MODEL-EXACT):
   * used so an in-flight platform operation keeps running on the provider revision it started on,
   * even after the admin publishes a newer revision and advances the current pointer.
   *
   * Fail-closed: an unknown provider, a missing / non-published revision, or a checksum that does not
   * match the pinned `providerChecksum` throws `AiCatalogNotFoundError` (never falls back to
   * current/latest). The optional `modelKey` must be enabled in this exact revision or
   * `AiCatalogModelNotPublishedError` is thrown. Secrets are re-read + decrypted at THIS revision's
   * secret fingerprint and never persisted.
   */
  async resolveProviderExecutionConfigAtRevision(params: {
    modelKey?: string;
    providerChecksum: string;
    providerKey: string;
    providerRevision: number;
  }): Promise<AiCatalogProviderExecutionConfig> {
    const repository = new PlatformAiCatalogRepository(this.db);
    const provider = await repository.getProviderByKey(params.providerKey);
    if (!provider || provider.status !== 'published') throw new AiCatalogNotFoundError();
    const revision = await repository.getProviderRevision(provider.id, params.providerRevision);
    if (
      !revision ||
      revision.status !== 'published' ||
      revision.checksum !== params.providerChecksum ||
      !isRecord(revision.payload.provider)
    ) {
      throw new AiCatalogNotFoundError();
    }
    const resolved = await this.buildExecutionConfigFromRevision(
      params.providerKey,
      revision,
      repository,
    );
    if (
      params.modelKey &&
      !resolved.allowedModels.some((model) => model.modelKey === params.modelKey)
    ) {
      throw new AiCatalogModelNotPublishedError(params.modelKey, 'chat');
    }
    return resolved;
  }

  private async buildExecutionConfigFromRevision(
    providerKey: string,
    revision: PlatformResourceRevisionItem,
    repository: PlatformAiCatalogRepository,
  ): Promise<AiCatalogProviderExecutionConfig> {
    if (!isRecord(revision.payload.provider)) throw new AiCatalogNotFoundError();
    const provider = revision.payload.provider;
    // Known but administratively disabled — fail closed (do not surface as PLATFORM_NOT_FOUND
    // or the runtime BYOK path will resurrect the provider with a user key).
    if (provider.enabled !== true) {
      throw new AiCatalogProviderDisabledError(
        typeof provider.providerKey === 'string' ? provider.providerKey : providerKey,
      );
    }
    const allowedModels = Array.isArray(revision.payload.models)
      ? revision.payload.models.flatMap((model) =>
          isRecord(model) &&
          model.enabled === true &&
          typeof model.modelKey === 'string' &&
          typeof model.type === 'string'
            ? [
                {
                  ...(isRecord(model.abilities) && typeof model.abilities.search === 'boolean'
                    ? { abilities: { search: model.abilities.search } }
                    : {}),
                  modelKey: model.modelKey,
                  ...(isRecord(model.settings) && typeof model.settings.searchImpl === 'string'
                    ? {
                        settings: {
                          searchImpl: model.settings.searchImpl as ModelSearchImplementType,
                        },
                      }
                    : {}),
                  type: model.type,
                },
              ]
            : [],
        )
      : [];
    const config = isRecord(provider.config) ? (provider.config as PlatformAiProviderConfig) : {};
    const settings = isRecord(provider.settings)
      ? (provider.settings as PlatformAiProviderSettings)
      : {};
    let keyVaults: PlatformProviderKeyVaults = {};
    if (revision.secretFingerprint) {
      const secretVersion = await repository.getProviderSecretVersion(
        revision.resourceId,
        revision.secretFingerprint,
      );
      if (!secretVersion) throw secretNotReadable();
      keyVaults = await this.secrets.decrypt(secretVersion.ciphertext);
    }
    const normalized = normalizeAiCatalogExecutionCredentials({
      config,
      keyVaults,
      providerKey,
      source: typeof provider.source === 'string' ? provider.source : 'custom',
      settings,
    });
    return {
      allowedModels,
      config,
      keyVaults: normalized.keyVaults,
      providerKey,
      revision: revision.revision,
      runtimeProvider: normalized.runtimeProvider,
    };
  }
}

export const getEmptyAiProviderRuntimeState = (): AiProviderRuntimeState => ({
  ...EMPTY_RUNTIME_STATE,
  runtimeConfig: {},
});

export const resolveAiCatalogRuntimeState = async (params: {
  db: LobeChatDatabase;
  flags?: EnterpriseFeatureFlags;
  upstreamState: AiProviderRuntimeState;
}): Promise<AiProviderRuntimeState> => {
  const flags = params.flags ?? parseEnterpriseFeatureFlags(process.env);
  if (!flags.ENABLE_PLATFORM_MANAGED_AI) return params.upstreamState;
  return new AiCatalogRuntimeAdapter(params.db).resolve({
    flags,
    upstreamState: params.upstreamState,
  });
};
