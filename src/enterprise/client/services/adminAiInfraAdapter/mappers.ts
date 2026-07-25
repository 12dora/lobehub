import type { AiProviderModelListItem, EnabledAiModel } from 'model-bank';

import type {
  AdminAiModelListItem,
  AdminAiProviderDraft,
  AdminAiProviderGetOutput,
  AdminAiProviderListItem,
} from '@/enterprise/client/features/admin/ai/types';
import type {
  AiProviderDetailItem,
  AiProviderListItem,
  AiProviderRuntimeConfig,
  AiProviderRuntimeState,
  EnabledProvider,
} from '@/types/aiProvider';
import { AiProviderSourceEnum } from '@/types/aiProvider';

/**
 * Map platform list row → user-facing provider list item (id = providerKey).
 *
 * `enabled` is taken from the **draft** row (list endpoint returns draft views).
 * After auto-publish the draft mirrors the live catalog; using draft keeps the
 * admin parity switch in sync with the form the admin is editing without a
 * second published-state round trip. When draft diverges (publish soft-fail),
 * the draft banner surfaces that the live catalog may lag.
 */
export const mapProviderListItem = (item: AdminAiProviderListItem): AiProviderListItem => ({
  description: item.description ?? undefined,
  enabled: item.enabled,
  id: item.providerKey,
  logo: item.logo ?? undefined,
  name: item.displayName,
  sort: item.sort,
  source: item.source === 'builtin' ? AiProviderSourceEnum.Builtin : AiProviderSourceEnum.Custom,
});

/**
 * Map platform get → user-facing detail.
 * - Secrets never leave the server (no plaintext keyVaults).
 * - Public endpoint is `config.endpoint` → form `keyVaults.baseURL` for display/edit.
 */
export const mapProviderDetail = (
  output: AdminAiProviderGetOutput,
): AiProviderDetailItem & { secretConfigured?: boolean } => {
  const draft = output.draft;
  const secretConfigured = draft.secret.configured;
  const endpoint =
    typeof draft.config?.endpoint === 'string' ? (draft.config.endpoint as string) : undefined;
  return {
    checkModel: draft.checkModel ?? undefined,
    description: draft.description ?? undefined,
    enabled: draft.enabled,
    fetchOnClient: false,
    id: draft.providerKey,
    // baseURL is public (config.endpoint); true credentials stay empty + secretConfigured.
    keyVaults: endpoint ? { baseURL: endpoint } : {},
    logo: draft.logo ?? undefined,
    name: draft.displayName,
    secretConfigured,
    settings: (draft.settings ?? {}) as AiProviderDetailItem['settings'],
    source: draft.source === 'builtin' ? AiProviderSourceEnum.Builtin : AiProviderSourceEnum.Custom,
  };
};

/**
 * Endpoint field tri-state from form keyVaults:
 * - `undefined` — field absent; leave prior endpoint
 * - `string` — explicit set
 * - `null` — administrator cleared the field; remove endpoint
 */
export type EndpointField = string | null | undefined;

/** Split form keyVaults: baseURL/endpoint → public config; remaining non-empty → secret merge. */
export const splitFormKeyVaults = (
  keyVaults?: Record<string, unknown> | null,
): { endpoint: EndpointField; secretParts: Record<string, string | Record<string, string>> } => {
  const raw = keyVaults ?? {};
  const hasEndpointField =
    Object.prototype.hasOwnProperty.call(raw, 'baseURL') ||
    Object.prototype.hasOwnProperty.call(raw, 'endpoint');

  let endpoint: EndpointField;
  if (hasEndpointField) {
    const endpointRaw = raw.baseURL ?? raw.endpoint;
    endpoint =
      typeof endpointRaw === 'string' && endpointRaw.trim().length > 0 ? endpointRaw.trim() : null;
  } else {
    endpoint = undefined;
  }

  const secretParts: Record<string, string | Record<string, string>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'baseURL' || key === 'endpoint') continue;
    if (typeof value === 'string' && value.length > 0) {
      secretParts[key] = value;
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
        ),
      );
      if (Object.keys(nested).length > 0) secretParts[key] = nested;
    }
  }
  return { endpoint, secretParts };
};

export const mapModelListItem = (
  item: AdminAiModelListItem | AdminAiProviderDraft['models'][number],
): AiProviderModelListItem => ({
  abilities: (item.abilities ?? {}) as AiProviderModelListItem['abilities'],
  config: (item.config ?? undefined) as AiProviderModelListItem['config'],
  contextWindowTokens: item.contextWindowTokens ?? undefined,
  displayName: item.displayName ?? undefined,
  enabled: item.enabled,
  id: item.modelKey,
  parameters: (item.parameters ?? undefined) as AiProviderModelListItem['parameters'],
  pricing: (item.pricing ?? undefined) as AiProviderModelListItem['pricing'],
  settings: (item.settings ?? undefined) as AiProviderModelListItem['settings'],
  source: 'custom',
  type: item.type,
});

export const mapEnabledModel = (
  item: AdminAiProviderDraft['models'][number],
  providerKey: string,
): EnabledAiModel => ({
  abilities: (item.abilities ?? {}) as EnabledAiModel['abilities'],
  config: (item.config ?? undefined) as EnabledAiModel['config'],
  contextWindowTokens: item.contextWindowTokens ?? undefined,
  displayName: item.displayName ?? undefined,
  enabled: item.enabled,
  id: item.modelKey,
  parameters: (item.parameters ?? undefined) as EnabledAiModel['parameters'],
  pricing: (item.pricing ?? undefined) as EnabledAiModel['pricing'],
  providerId: providerKey,
  settings: (item.settings ?? undefined) as EnabledAiModel['settings'],
  sort: item.sort ?? undefined,
  type: item.type as EnabledAiModel['type'],
});

/**
 * Build runtime state for ModelList / EnableSwitch from admin list + draft models.
 * keyVaults are always empty (platform secrets never leave the server).
 */
export const buildAdminRuntimeState = (
  providers: AdminAiProviderListItem[],
  modelsByProviderKey: Map<string, AdminAiProviderDraft['models']>,
): AiProviderRuntimeState => {
  const active = providers.filter((p) => p.status !== 'archived');
  const enabledProviders: EnabledProvider[] = active
    .filter((p) => p.enabled)
    .map((p) => ({
      id: p.providerKey,
      logo: p.logo ?? undefined,
      name: p.displayName,
      source: p.source === 'builtin' ? AiProviderSourceEnum.Builtin : AiProviderSourceEnum.Custom,
    }));

  const enabledAiModels: EnabledAiModel[] = [];
  for (const provider of active) {
    if (!provider.enabled) continue;
    const models = modelsByProviderKey.get(provider.providerKey) ?? [];
    for (const model of models) {
      if (!model.enabled) continue;
      enabledAiModels.push(mapEnabledModel(model, provider.providerKey));
    }
  }

  const runtimeConfig: Record<string, AiProviderRuntimeConfig> = {};
  for (const provider of active) {
    runtimeConfig[provider.providerKey] = {
      config: (provider.config ?? {}) as AiProviderRuntimeConfig['config'],
      fetchOnClient: false,
      keyVaults: {},
      settings: (provider.settings ?? {}) as AiProviderRuntimeConfig['settings'],
    };
  }

  const hasType = (type: string) => (provider: EnabledProvider) =>
    enabledAiModels.some((m) => m.providerId === provider.id && m.type === type);

  return {
    enabledAiModels,
    enabledAiProviders: enabledProviders,
    enabledChatAiProviders: enabledProviders.filter(hasType('chat')),
    enabledImageAiProviders: enabledProviders.filter(hasType('image')),
    enabledVideoAiProviders: enabledProviders.filter(hasType('video')),
    runtimeConfig,
  };
};
