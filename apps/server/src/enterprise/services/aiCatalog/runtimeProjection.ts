import type {
  AiProviderRuntimeConfig,
  AiProviderRuntimeState,
  EnabledProvider,
} from '@lobechat/types';
import { merge } from '@lobechat/utils';
import { isRecord } from '@lobechat/utils/object';
import type { EnabledAiModel } from 'model-bank';
import {
  applyChatGPTWebModelPolicy,
  LOBE_DEFAULT_MODEL_LIST,
  projectPickerVisibility,
} from 'model-bank';
import { isWebAppProvider } from 'model-bank/modelProviders';

import type {
  PlatformAiProviderConfig,
  PlatformAiProviderSettings,
  PlatformResourceRevisionItem,
} from '@/database/schemas/platform';

import {
  normalizeAiCatalogExecutionCredentials,
  resolveAiCatalogRuntimeProvider,
} from './credentialAdapter';
import { AiCatalogValidationError } from './errors';

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

/**
 * Credential-free provider settings safe to expose in public runtime state.
 * OAuth / proxy / sdkType stay server-only. The webApp capability is a
 * server-owned field on `capabilities` — never copied from stored settings.
 */
export const projectPublicAiProviderRuntimeSettings =
  (): AiProviderRuntimeConfig['settings'] => ({});

/**
 * Server-owned webApp flag, derived from the actual runtime provider card so a
 * managed alias like `corp-cursor` still skips generic prompt injections.
 * User provider schemas cannot populate `capabilities`.
 */
export const projectPublicAiProviderRuntimeCapabilities = (
  providerKey: string,
  settings: unknown,
  source: unknown,
): AiProviderRuntimeConfig['capabilities'] | undefined => {
  const platformSettings = isRecord(settings) ? (settings as PlatformAiProviderSettings) : {};
  const runtimeProvider = resolveAiCatalogRuntimeProvider(
    providerKey,
    platformSettings,
    typeof source === 'string' ? source : 'custom',
  );
  return isWebAppProvider(runtimeProvider) ? { webApp: true } : undefined;
};

/**
 * Drop spoofable webApp markers from a user-owned (BYOK / upstream) runtime
 * config before it is returned as runtime state. `capabilities` is server-owned
 * and is never copied from upstream; `settings.webApp` is stripped even if a
 * user stored it before the schema rejected the field.
 */
const omitSettingsWebApp = (
  settings: AiProviderRuntimeConfig['settings'] | undefined,
): AiProviderRuntimeConfig['settings'] => {
  if (!settings || !('webApp' in settings)) return settings ?? {};
  const { webApp: _webApp, ...rest } = settings;
  return rest;
};

export const stripUserSpoofableRuntimeConfig = (
  config: AiProviderRuntimeConfig,
): AiProviderRuntimeConfig => {
  const { capabilities: _capabilities, settings, ...rest } = config;
  return { ...rest, settings: omitSettingsWebApp(settings) };
};

const EMPTY_RUNTIME_STATE: AiProviderRuntimeState = {
  enabledAiModels: [],
  enabledAiProviders: [],
  enabledChatAiProviders: [],
  enabledImageAiProviders: [],
  enabledVideoAiProviders: [],
  runtimeConfig: {},
};

export const getEmptyAiProviderRuntimeState = (): AiProviderRuntimeState => ({
  ...EMPTY_RUNTIME_STATE,
  runtimeConfig: {},
});

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

const builtinModelMap = new Map(
  LOBE_DEFAULT_MODEL_LIST.map((model) => [`${model.providerId}:${model.id}`, model]),
);

const hasPublishedMetadata = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).length > 0;

/**
 * Vault presence is the wrong skip predicate: Ollama / ComfyUI execute from
 * `config.endpoint` with no secret at all, while a cleared shared OAuth account
 * cannot. Ask the same normalizer execution uses — empty vault + published
 * config + env — whether credentials would be complete.
 */
export const canExecuteAiCatalogProviderWithoutStoredSecret = (
  providerKey: string,
  provider: Record<string, unknown>,
): boolean => {
  const settings = isRecord(provider.settings)
    ? (provider.settings as PlatformAiProviderSettings)
    : {};
  const source = typeof provider.source === 'string' ? provider.source : 'custom';
  const config = isRecord(provider.config) ? (provider.config as PlatformAiProviderConfig) : {};
  try {
    normalizeAiCatalogExecutionCredentials({
      config,
      keyVaults: {},
      providerKey,
      source,
      settings,
    });
    return true;
  } catch (error) {
    if (error instanceof AiCatalogValidationError) return false;
    throw error;
  }
};

const cannotExecuteWithoutManagedSecret = (
  provider: Record<string, unknown>,
  providerKey: string,
): boolean => {
  // Older published payloads omit the flag; they stay visible because we cannot
  // assume the vault is empty. Only an explicit `false` is a cleared secret.
  if (provider.secretConfigured !== false) return false;
  return !canExecuteAiCatalogProviderWithoutStoredSecret(providerKey, provider);
};

export const projectAiCatalogRuntimeState = (
  revisions: PlatformResourceRevisionItem[],
): AiProviderRuntimeState => {
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
    if (cannotExecuteWithoutManagedSecret(provider, providerKey)) continue;
    sortedProviders.push({
      provider: {
        id: providerKey,
        logo: typeof provider.logo === 'string' ? provider.logo : undefined,
        name: provider.displayName,
        source: provider.source === 'builtin' ? 'builtin' : 'custom',
      },
      sort: typeof provider.sort === 'number' ? provider.sort : Number.MAX_SAFE_INTEGER,
    });
    const capabilities = projectPublicAiProviderRuntimeCapabilities(
      providerKey,
      provider.settings,
      provider.source,
    );
    runtimeConfig[providerKey] = {
      ...(capabilities ? { capabilities } : {}),
      config: projectPublicAiProviderRuntimeConfig(provider.config),
      fetchOnClient: false,
      keyVaults: {},
      settings: projectPublicAiProviderRuntimeSettings(),
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
      const abilities = hasPublishedMetadata(rawModel.abilities)
        ? rawModel.abilities
        : (builtin?.abilities ?? {});
      const mergedSettings = hasPublishedMetadata(rawModel.settings)
        ? merge(builtin?.settings || {}, rawModel.settings)
        : builtin?.settings;
      const policy = applyChatGPTWebModelPolicy({
        abilities,
        modelId: rawModel.modelKey,
        providerId: providerKey,
        settings: mergedSettings,
      });
      models.push({
        ...builtin,
        abilities,
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
        settings: policy.settings,
        sort: typeof rawModel.sort === 'number' ? rawModel.sort : undefined,
        source: builtin ? 'builtin' : 'custom',
        type: typeof rawModel.type === 'string' ? rawModel.type : 'chat',
        ...projectPickerVisibility(policy.settings),
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
  return state;
};
