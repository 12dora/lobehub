import type { ModelRuntimeHooks } from '@lobechat/model-runtime';
import type { AiProviderRuntimeState, EnabledProvider } from '@lobechat/types';
import { isRecord } from '@lobechat/utils/object';
import type { ModelSearchImplementType } from 'model-bank';

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
import {
  hasAiCatalogEnvironmentFallback,
  normalizeAiCatalogExecutionCredentials,
  resolveAiCatalogRuntimeProvider,
} from './credentialAdapter';
import { isPlatformAiTakeoverActive } from './enforcement';
import {
  AiCatalogModelNotPublishedError,
  AiCatalogNotFoundError,
  AiCatalogProviderUnavailableError,
} from './errors';
import { projectAiCatalogRuntimeState } from './runtimeProjection';
import type { PlatformProviderKeyVaults } from './secretManager';
import { AiCatalogSecretManager } from './secretManager';
import { isOAuthAuthorizationExpiredError, refreshSharedOAuthVault } from './sharedOAuthRefresh';

export type { AiCatalogShadowComparison } from './runtimeProjection';
export {
  compareAiCatalogRuntimeStates,
  getEmptyAiProviderRuntimeState,
  projectPublicAiProviderRuntimeConfig,
  recordAiCatalogShadowComparison,
} from './runtimeProjection';

export interface AiCatalogExecutionResolveOptions {
  /**
   * Readiness/health probes must stay free of outbound I/O: skip the shared-OAuth
   * refresh entirely (no token-endpoint calls, no cross-instance lease waits).
   */
  skipSharedOAuthRefresh?: boolean;
}

const runtimeCache = new Map<string, AiProviderRuntimeState>();
const MAX_RUNTIME_CACHE_ENTRIES = 20;
let activeRuntimeLoad: { generation: number; promise: Promise<AiProviderRuntimeState> } | undefined;
let runtimeCacheGeneration = 0;
/** Bounded server-side log line for a transient shared-OAuth refresh failure. */
const MAX_REFRESH_FAILURE_CHARS = 200;

/**
 * Never log a refresh error object: an authorization server's `error_description` is
 * provider-controlled prose that can echo request material back into our logs, and the
 * `cause` chain drags the raw transport error (URLs, headers) along with it. Only the error
 * class and a bounded message survive.
 */
const describeRefreshFailure = (error: unknown): string => {
  if (!(error instanceof Error)) return 'unknown error';
  const message = error.message.slice(0, MAX_REFRESH_FAILURE_CHARS).replaceAll(/\s+/g, ' ').trim();
  return message ? `${error.name}: ${message}` : error.name;
};

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

      const state = projectAiCatalogRuntimeState(revisions);
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
    options?: AiCatalogExecutionResolveOptions,
  ): Promise<AiCatalogProviderExecutionConfig> {
    const repository = new PlatformAiCatalogRepository(this.db);
    const { revisions } = await loadCurrentAiCatalogSnapshot(this.db);
    const revision = revisions.find(
      (item) =>
        isRecord(item.payload.provider) && item.payload.provider.providerKey === providerKey,
    );
    if (!revision || !isRecord(revision.payload.provider)) {
      // Platform takeover applies only while a provider is actively managed. A provider that
      // is absent from the snapshot (never managed, or archived) is reported as NOT_FOUND so
      // the ModelRuntime bridge falls back to the user's own BYOK configuration. Re-enabling
      // the platform provider puts it back in the snapshot, and the platform path — which is
      // tried first — takes precedence again automatically.
      throw new AiCatalogNotFoundError();
    }
    return this.buildExecutionConfigFromRevision(providerKey, revision, repository, options);
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
    const unavailable = () => new AiCatalogProviderUnavailableError(params.providerKey);
    const provider = await repository.getProviderByKey(params.providerKey);
    // A hard-deleted provider takes its revision history with it, so an in-flight pinned
    // operation lands here on its next resolve and fails with a labelled provider error
    // (never an opaque internal error, never a silent switch to another configuration).
    if (!provider || provider.status !== 'published') throw unavailable();
    const revision = await repository.getProviderRevision(provider.id, params.providerRevision);
    if (
      !revision ||
      revision.status !== 'published' ||
      revision.checksum !== params.providerChecksum ||
      !isRecord(revision.payload.provider)
    ) {
      throw unavailable();
    }
    let resolved;
    try {
      resolved = await this.buildExecutionConfigFromRevision(
        params.providerKey,
        revision,
        repository,
      );
    } catch (error) {
      // The shared builder reports "not managed" as NOT_FOUND for the BYOK-fallback path;
      // on the pinned path there is no fallback, so it is a terminal provider error.
      if (error instanceof AiCatalogNotFoundError) throw unavailable();
      throw error;
    }
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
    options?: AiCatalogExecutionResolveOptions,
  ): Promise<AiCatalogProviderExecutionConfig> {
    if (!isRecord(revision.payload.provider)) throw new AiCatalogNotFoundError();
    const provider = revision.payload.provider;
    // Administratively disabled ⇒ not managed. Surfaced as NOT_FOUND so the current-pointer
    // path hands the provider back to the user's own BYOK config (see
    // resolveProviderExecutionConfig). The pinned-revision path has no BYOK fallback, so this
    // stays terminal there.
    if (provider.enabled !== true) throw new AiCatalogNotFoundError();
    // Disconnect leaves the provider enabled (dependents stay valid) and only clears the
    // vault. A secret-less current pointer is the same "not managed" signal as disabled,
    // unless the runtime can still execute from the environment. Pinned revisions remap
    // this NOT_FOUND to a terminal unavailable — a historical pin is not BYOK.
    const settings = isRecord(provider.settings)
      ? (provider.settings as PlatformAiProviderSettings)
      : {};
    const source = typeof provider.source === 'string' ? provider.source : 'custom';
    if (
      !revision.secretFingerprint &&
      !hasAiCatalogEnvironmentFallback(
        resolveAiCatalogRuntimeProvider(providerKey, settings, source),
      )
    ) {
      throw new AiCatalogNotFoundError();
    }
    const allowedModels = Array.isArray(revision.payload.models)
      ? revision.payload.models.flatMap((model) =>
          isRecord(model) && model.enabled === true && typeof model.modelKey === 'string'
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
                  // Same default as the projection (`type: … : 'chat'`). A payload without an
                  // explicit type must not show up in the picker as a chat model while being
                  // absent from the allowlist — that combination is a guaranteed
                  // PLATFORM_AI_MODEL_NOT_PUBLISHED on a model the user was offered.
                  type: typeof model.type === 'string' ? model.type : 'chat',
                },
              ]
            : [],
        )
      : [];
    const config = isRecord(provider.config) ? (provider.config as PlatformAiProviderConfig) : {};
    let keyVaults: PlatformProviderKeyVaults = {};
    if (revision.secretFingerprint) {
      const secretVersion = await repository.getProviderSecretVersion(
        revision.resourceId,
        revision.secretFingerprint,
      );
      if (!secretVersion) throw secretNotReadable();
      keyVaults = await this.secrets.decrypt(secretVersion.ciphertext);
      // Shared rotating-refresh OAuth credentials (chatgpt/supergrok) are refreshed here
      // — the single seam every execution resolver passes through — so the runtime always
      // receives a token that outlives the request. No-op for every other provider.
      // Readiness probes pass skipSharedOAuthRefresh: a health check must never make
      // outbound token calls, wait on a refresh lease, or let a third-party OAuth blip
      // downgrade managed-resource enforcement.
      if (!options?.skipSharedOAuthRefresh) {
        try {
          keyVaults = await refreshSharedOAuthVault({
            ciphertext: secretVersion.ciphertext,
            db: this.db,
            fingerprint: revision.secretFingerprint,
            keyVaults,
            providerKey,
            providerRowId: revision.resourceId,
            secrets: this.secrets,
          });
        } catch (error) {
          // Only a dead grant is actionable for the caller. Transient failures (network,
          // token endpoint 5xx, lost persist race) degrade to the stored vault — the
          // access token may still be inside its expiry skew, and the next request
          // re-enters the refresh path.
          if (isOAuthAuthorizationExpiredError(error)) throw error;
          console.error(
            `[ai-catalog] shared OAuth refresh for ${providerKey} failed transiently; using stored vault: ${describeRefreshFailure(error)}`,
          );
        }
      }
    }
    const normalized = normalizeAiCatalogExecutionCredentials({
      config,
      keyVaults,
      providerKey,
      source,
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

/**
 * Union the caller's own (BYOK / self-built) providers into the platform-managed state.
 *
 * Under takeover the platform governs the providers it PUBLISHES AS ENABLED; everything else
 * is still the user's own. That is exactly what the execution path already does
 * (`PLATFORM_NOT_FOUND` ⇒ `initUserModelRuntimeFromDB`) and what the settings model list does
 * (`listPublishedModels` returns `null` for an unmanaged provider). Without this merge the
 * listing layer would be the only layer in the stack without the BYOK fallback: a provider the
 * user configured and can execute against would never appear in the chat picker.
 *
 * Rules:
 * - published providers win on id collision (the platform takeover is total for what it publishes);
 * - `runtimeConfig` merges the same way — managed entries stay credential-free
 *   (`projectPublicAiProviderRuntimeConfig`), unmanaged entries keep the upstream user config;
 * - every provider list (`enabledChat/Image/Video`) merges consistently with `enabledAiModels`.
 *
 * MUST stay outside `AiCatalogRuntimeAdapter.loadRuntimeState`: that snapshot is cached
 * process-wide and keyed by the catalog token, so a per-user state must never reach it. The
 * managed state is treated as immutable here for the same reason.
 */
/**
 * Under takeover only providers the member has actually configured themselves survive the
 * union: a custom provider, or a builtin one they stored credentials for. Model-bank
 * "enabled by default" builtins with an empty vault are NOT the member's own configuration —
 * vanilla LobeHub lists them so the user can go and add a key, but the settings page is
 * boundary-blocked under 平台托管, so listing them would only offer models that cannot run.
 */
const isUserConfiguredProvider = (
  provider: EnabledProvider,
  runtimeConfig: AiProviderRuntimeState['runtimeConfig'] | undefined,
): boolean => {
  if (provider.source === 'custom') return true;
  const keyVaults = runtimeConfig?.[provider.id]?.keyVaults ?? {};
  return Object.values(keyVaults).some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
};

export const mergeUnmanagedUpstreamProviders = (
  managed: AiProviderRuntimeState,
  upstream: AiProviderRuntimeState,
): AiProviderRuntimeState => {
  const managedIds = new Set(managed.enabledAiProviders.map((provider) => provider.id));
  const unmanagedProviders = upstream.enabledAiProviders.filter(
    (provider) =>
      !managedIds.has(provider.id) && isUserConfiguredProvider(provider, upstream.runtimeConfig),
  );
  const unmanagedConfigKeys = Object.keys(upstream.runtimeConfig ?? {}).filter(
    (key) => !managedIds.has(key),
  );
  if (unmanagedProviders.length === 0 && unmanagedConfigKeys.length === 0) return managed;

  const unmanagedIds = new Set(unmanagedProviders.map((provider) => provider.id));
  const keepUnmanaged = (providers: EnabledProvider[]) =>
    providers.filter((provider) => unmanagedIds.has(provider.id));

  const runtimeConfig = { ...managed.runtimeConfig };
  for (const key of unmanagedConfigKeys) {
    const config = upstream.runtimeConfig?.[key];
    if (config) runtimeConfig[key] = config;
  }

  return {
    enabledAiModels: [
      ...managed.enabledAiModels,
      ...upstream.enabledAiModels.filter((model) => unmanagedIds.has(model.providerId)),
    ],
    enabledAiProviders: [...managed.enabledAiProviders, ...unmanagedProviders],
    enabledChatAiProviders: [
      ...managed.enabledChatAiProviders,
      ...keepUnmanaged(upstream.enabledChatAiProviders),
    ],
    enabledImageAiProviders: [
      ...managed.enabledImageAiProviders,
      ...keepUnmanaged(upstream.enabledImageAiProviders),
    ],
    enabledVideoAiProviders: [
      ...managed.enabledVideoAiProviders,
      ...keepUnmanaged(upstream.enabledVideoAiProviders),
    ],
    runtimeConfig,
  };
};

/**
 * Platform-managed runtime state, or the caller's own state verbatim when the platform has
 * not taken over.
 *
 * The feature flag alone is NOT authorization: an admin who merely connects a shared account
 * or publishes a provider must not silently replace every user's configuration. Only the
 * published 平台托管 policy (`isPlatformAiTakeoverActive`) does that.
 */
export const resolveAiCatalogRuntimeState = async (params: {
  db: LobeChatDatabase;
  flags?: EnterpriseFeatureFlags;
  upstreamState: AiProviderRuntimeState;
}): Promise<AiProviderRuntimeState> => {
  const flags = params.flags ?? parseEnterpriseFeatureFlags(process.env);
  if (!flags.ENABLE_PLATFORM_MANAGED_AI) return params.upstreamState;
  if (!(await isPlatformAiTakeoverActive(params.db, flags))) return params.upstreamState;
  const state = await new AiCatalogRuntimeAdapter(params.db).resolve({
    flags,
    upstreamState: params.upstreamState,
  });
  return mergeUnmanagedUpstreamProviders(state, params.upstreamState);
};
