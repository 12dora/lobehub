import type { ModelRuntimeHooks } from '@lobechat/model-runtime';
import type {
  AiProviderRuntimeConfig,
  AiProviderRuntimeState,
  EnabledProvider,
} from '@lobechat/types';
import { isRecord } from '@lobechat/utils/object';
import { type EnabledAiModel, LOBE_DEFAULT_MODEL_LIST } from 'model-bank';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type {
  PlatformAiProviderConfig,
  PlatformAiProviderSettings,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { type PlatformSecretService, secretNotReadable } from '../../security/secret';
import { normalizeAiCatalogExecutionCredentials } from './credentialAdapter';
import { AiCatalogModelNotPublishedError, AiCatalogNotFoundError } from './errors';
import type { PlatformProviderKeyVaults } from './secretManager';
import { AiCatalogSecretManager } from './secretManager';

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

let lastShadowComparison: AiCatalogShadowComparison | null = null;

export const recordAiCatalogShadowComparison = (
  upstream: AiProviderRuntimeState,
  managed: AiProviderRuntimeState,
): AiCatalogShadowComparison => {
  const comparison = compareAiCatalogRuntimeStates(upstream, managed);
  lastShadowComparison = comparison;
  return comparison;
};

export const getLastAiCatalogShadowComparison = (): AiCatalogShadowComparison | null =>
  lastShadowComparison;

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
  lastShadowComparison = null;
  runtimeCache.clear();
};

export class AiCatalogRuntimeAdapter {
  private readonly db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  resolve = async (params: {
    flags?: EnterpriseFeatureFlags;
    upstreamState: AiProviderRuntimeState;
  }): Promise<AiProviderRuntimeState> => {
    const flags = params.flags ?? parseEnterpriseFeatureFlags(process.env);
    // Exact rollback compatibility: no catalog DB read, decrypt, or cache access.
    if (!flags.ENABLE_PLATFORM_MANAGED_AI) return params.upstreamState;

    const repository = new PlatformAiCatalogRepository(this.db);
    const revisions = await repository.listLatestPublishedProviderRevisions();
    const cacheKey = revisions
      .map(
        (revision) =>
          `${revision.resourceId}:${revision.revision}:${revision.checksum}:${revision.secretFingerprint ?? ''}`,
      )
      .join('|');
    const cached = runtimeCache.get(cacheKey);
    if (cached) return cached;

    const sortedProviders: Array<{ provider: EnabledProvider; sort: number }> = [];
    const models: EnabledAiModel[] = [];
    const runtimeConfig: Record<string, AiProviderRuntimeConfig> = {};

    for (const revision of revisions) {
      if (!isRecord(revision.payload.provider) || !Array.isArray(revision.payload.models)) continue;
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
        config: {},
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
            typeof rawModel.description === 'string' ? rawModel.description : builtin?.description,
          displayName:
            typeof rawModel.displayName === 'string' ? rawModel.displayName : builtin?.displayName,
          enabled: true,
          id: rawModel.modelKey,
          parameters: hasPublishedMetadata(rawModel.parameters)
            ? rawModel.parameters
            : builtin?.parameters,
          pricing: hasPublishedMetadata(rawModel.pricing) ? rawModel.pricing : builtin?.pricing,
          providerId: providerKey,
          settings: hasPublishedMetadata(rawModel.settings) ? rawModel.settings : builtin?.settings,
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
    return cacheState(cacheKey, {
      enabledAiModels: models,
      enabledAiProviders: providers,
      enabledChatAiProviders: providers.filter((provider) => providerHasType(provider, 'chat')),
      enabledImageAiProviders: providers.filter((provider) => providerHasType(provider, 'image')),
      enabledVideoAiProviders: providers.filter((provider) => providerHasType(provider, 'video')),
      runtimeConfig,
    });
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
  modelKey: string;
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
    const revisions = await repository.listLatestPublishedProviderRevisions();
    const revision = revisions.find(
      (item) =>
        isRecord(item.payload.provider) && item.payload.provider.providerKey === providerKey,
    );
    if (!revision || !isRecord(revision.payload.provider)) {
      throw new AiCatalogNotFoundError();
    }
    const provider = revision.payload.provider;
    if (provider.enabled !== true) throw new AiCatalogNotFoundError();
    const allowedModels = Array.isArray(revision.payload.models)
      ? revision.payload.models.flatMap((model) =>
          isRecord(model) &&
          model.enabled === true &&
          typeof model.modelKey === 'string' &&
          typeof model.type === 'string'
            ? [{ modelKey: model.modelKey, type: model.type }]
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
