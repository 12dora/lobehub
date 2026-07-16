import type { ModelRuntimeHooks } from '@lobechat/model-runtime';
import type {
  AiProviderRuntimeConfig,
  AiProviderRuntimeState,
  EnabledProvider,
} from '@lobechat/types';
import { isRecord } from '@lobechat/utils/object';
import type { EnabledAiModel } from 'model-bank';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { type PlatformSecretService, secretNotReadable } from '../../security/secret';
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
  managedModelCount: number;
  managedProviderCount: number;
  modelOnlyInManaged: string[];
  modelOnlyInUpstream: string[];
  providerOnlyInManaged: string[];
  providerOnlyInUpstream: string[];
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

const sortedDifference = (left: Set<string>, right: Set<string>): string[] =>
  [...left].filter((item) => !right.has(item)).sort();

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
  return {
    managedModelCount: managedModels.size,
    managedProviderCount: managedProviders.size,
    modelOnlyInManaged: sortedDifference(managedModels, upstreamModels),
    modelOnlyInUpstream: sortedDifference(upstreamModels, managedModels),
    providerOnlyInManaged: sortedDifference(managedProviders, upstreamProviders),
    providerOnlyInUpstream: sortedDifference(upstreamProviders, managedProviders),
    upstreamModelCount: upstreamModels.size,
    upstreamProviderCount: upstreamProviders.size,
  };
};

const runtimeCache = new Map<string, AiProviderRuntimeState>();
const MAX_RUNTIME_CACHE_ENTRIES = 20;

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
        models.push({
          abilities: isRecord(rawModel.abilities) ? rawModel.abilities : {},
          contextWindowTokens:
            typeof rawModel.contextWindowTokens === 'number'
              ? rawModel.contextWindowTokens
              : undefined,
          description: typeof rawModel.description === 'string' ? rawModel.description : undefined,
          displayName: typeof rawModel.displayName === 'string' ? rawModel.displayName : undefined,
          enabled: true,
          id: rawModel.modelKey,
          parameters: isRecord(rawModel.parameters) ? rawModel.parameters : undefined,
          pricing: isRecord(rawModel.pricing) ? rawModel.pricing : undefined,
          providerId: providerKey,
          settings: isRecord(rawModel.settings) ? rawModel.settings : undefined,
          sort: typeof rawModel.sort === 'number' ? rawModel.sort : undefined,
          source: 'custom',
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
    const config = isRecord(provider.config) ? provider.config : {};
    const settings = isRecord(provider.settings) ? provider.settings : {};
    let keyVaults: PlatformProviderKeyVaults = {};
    if (revision.secretFingerprint) {
      const secretVersion = await repository.getProviderSecretVersion(
        revision.resourceId,
        revision.secretFingerprint,
      );
      if (!secretVersion) throw secretNotReadable();
      keyVaults = await this.secrets.decrypt(secretVersion.ciphertext);
    }
    if (typeof config.endpoint === 'string' && !keyVaults.baseURL) {
      keyVaults = { ...keyVaults, baseURL: config.endpoint };
    }
    return {
      allowedModels,
      config,
      keyVaults,
      providerKey,
      revision: revision.revision,
      runtimeProvider: typeof settings.sdkType === 'string' ? settings.sdkType : providerKey,
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
