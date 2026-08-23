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

interface EnabledProviderPayload {
  displayName: string;
  providerKey: string;
}

const isEnabledProviderPayload = (
  provider: Record<string, unknown>,
): provider is Record<string, unknown> & EnabledProviderPayload =>
  provider.enabled === true &&
  typeof provider.providerKey === 'string' &&
  typeof provider.displayName === 'string';

const isEnabledModelPayload = (
  rawModel: unknown,
): rawModel is Record<string, unknown> & { modelKey: string } =>
  isRecord(rawModel) && rawModel.enabled === true && typeof rawModel.modelKey === 'string';

const pickIfString = <T>(value: unknown, fallback: T): string | T =>
  typeof value === 'string' ? value : fallback;

const pickIfNumber = <T>(value: unknown, fallback: T): number | T =>
  typeof value === 'number' ? value : fallback;

const publishedMetadataOr = <T>(value: unknown, fallback: T): T =>
  hasPublishedMetadata(value) ? (value as T) : fallback;

const toSortedEnabledProvider = (
  provider: Record<string, unknown> & EnabledProviderPayload,
): { provider: EnabledProvider; sort: number } => ({
  provider: {
    id: provider.providerKey,
    logo: typeof provider.logo === 'string' ? provider.logo : undefined,
    name: provider.displayName,
    source: provider.source === 'builtin' ? 'builtin' : 'custom',
  },
  sort: typeof provider.sort === 'number' ? provider.sort : Number.MAX_SAFE_INTEGER,
});

const toPublicRuntimeConfig = (
  providerKey: string,
  provider: Record<string, unknown>,
): AiProviderRuntimeConfig => {
  const capabilities = projectPublicAiProviderRuntimeCapabilities(
    providerKey,
    provider.settings,
    provider.source,
  );
  return {
    ...(capabilities ? { capabilities } : {}),
    config: projectPublicAiProviderRuntimeConfig(provider.config),
    fetchOnClient: false,
    keyVaults: {},
    settings: projectPublicAiProviderRuntimeSettings(),
  };
};

const mergePublishedModelSettings = (
  published: unknown,
  builtinSettings: EnabledAiModel['settings'] | undefined,
) => (hasPublishedMetadata(published) ? merge(builtinSettings || {}, published) : builtinSettings);

const toEnabledAiModel = (
  providerKey: string,
  rawModel: Record<string, unknown> & { modelKey: string },
): EnabledAiModel => {
  const builtin = builtinModelMap.get(`${providerKey}:${rawModel.modelKey}`);
  const publishedConfig = isRecord(rawModel.config) ? rawModel.config : {};
  const deploymentName = pickIfString(publishedConfig.deploymentName, undefined);
  const abilities = publishedMetadataOr(rawModel.abilities, builtin?.abilities ?? {});
  const policy = applyChatGPTWebModelPolicy({
    abilities,
    modelId: rawModel.modelKey,
    providerId: providerKey,
    settings: mergePublishedModelSettings(rawModel.settings, builtin?.settings),
  });
  return {
    ...builtin,
    abilities,
    config: {
      ...builtin?.config,
      ...(deploymentName ? { deploymentName } : {}),
    },
    contextWindowTokens: pickIfNumber(rawModel.contextWindowTokens, builtin?.contextWindowTokens),
    description: pickIfString(rawModel.description, builtin?.description),
    displayName: pickIfString(rawModel.displayName, builtin?.displayName),
    enabled: true,
    id: rawModel.modelKey,
    parameters: publishedMetadataOr(rawModel.parameters, builtin?.parameters),
    pricing: publishedMetadataOr(rawModel.pricing, builtin?.pricing),
    providerId: providerKey,
    settings: policy.settings,
    sort: pickIfNumber(rawModel.sort, undefined),
    source: builtin ? 'builtin' : 'custom',
    type: pickIfString(rawModel.type, 'chat'),
    ...projectPickerVisibility(policy.settings),
  } as EnabledAiModel;
};

const projectEnabledRevision = (revision: PlatformResourceRevisionItem) => {
  if (!isRecord(revision.payload.provider) || !Array.isArray(revision.payload.models)) {
    return undefined;
  }
  const provider = revision.payload.provider;
  if (!isEnabledProviderPayload(provider)) return undefined;
  if (cannotExecuteWithoutManagedSecret(provider, provider.providerKey)) return undefined;

  const models: EnabledAiModel[] = [];
  for (const rawModel of revision.payload.models) {
    if (!isEnabledModelPayload(rawModel)) continue;
    models.push(toEnabledAiModel(provider.providerKey, rawModel));
  }

  return {
    models,
    providerKey: provider.providerKey,
    runtimeConfig: toPublicRuntimeConfig(provider.providerKey, provider),
    sortedProvider: toSortedEnabledProvider(provider),
  };
};

const compareProviderSort = (
  left: { provider: EnabledProvider; sort: number },
  right: { provider: EnabledProvider; sort: number },
) => left.sort - right.sort || left.provider.id.localeCompare(right.provider.id);

const compareModelSort = (left: EnabledAiModel, right: EnabledAiModel) =>
  (left.sort ?? Number.MAX_SAFE_INTEGER) - (right.sort ?? Number.MAX_SAFE_INTEGER) ||
  left.providerId.localeCompare(right.providerId) ||
  left.id.localeCompare(right.id);

const assembleAiProviderRuntimeState = (
  providers: EnabledProvider[],
  models: EnabledAiModel[],
  runtimeConfig: Record<string, AiProviderRuntimeConfig>,
): AiProviderRuntimeState => {
  const providerHasType = (provider: EnabledProvider, type: string) =>
    models.some((model) => model.providerId === provider.id && model.type === type);
  return {
    enabledAiModels: models,
    enabledAiProviders: providers,
    enabledChatAiProviders: providers.filter((provider) => providerHasType(provider, 'chat')),
    enabledImageAiProviders: providers.filter((provider) => providerHasType(provider, 'image')),
    enabledVideoAiProviders: providers.filter((provider) => providerHasType(provider, 'video')),
    runtimeConfig,
  } satisfies AiProviderRuntimeState;
};

export const projectAiCatalogRuntimeState = (
  revisions: PlatformResourceRevisionItem[],
): AiProviderRuntimeState => {
  const sortedProviders: Array<{ provider: EnabledProvider; sort: number }> = [];
  const models: EnabledAiModel[] = [];
  const runtimeConfig: Record<string, AiProviderRuntimeConfig> = {};

  for (const revision of revisions) {
    const projected = projectEnabledRevision(revision);
    if (!projected) continue;
    sortedProviders.push(projected.sortedProvider);
    runtimeConfig[projected.providerKey] = projected.runtimeConfig;
    models.push(...projected.models);
  }

  sortedProviders.sort(compareProviderSort);
  models.sort(compareModelSort);
  return assembleAiProviderRuntimeState(
    sortedProviders.map(({ provider }) => provider),
    models,
    runtimeConfig,
  );
};
