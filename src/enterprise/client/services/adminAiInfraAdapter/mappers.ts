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

/** Map platform list row → user-facing provider list item (id = providerKey). */
export const mapProviderListItem = (item: AdminAiProviderListItem): AiProviderListItem => ({
  description: item.description ?? undefined,
  // Prefer published enabled for list toggles when draft diverges — admin UI shows draft,
  // but "enabled" switch should reflect the live/published intent after auto-publish.
  enabled: item.enabled,
  id: item.providerKey,
  logo: item.logo ?? undefined,
  name: item.displayName,
  sort: item.sort,
  source: item.source === 'builtin' ? AiProviderSourceEnum.Builtin : AiProviderSourceEnum.Custom,
});

/** Map platform get → user-facing detail. Never embeds secret plaintext. */
export const mapProviderDetail = (
  output: AdminAiProviderGetOutput,
): AiProviderDetailItem & { secretConfigured?: boolean } => {
  const draft = output.draft;
  const secretConfigured = draft.secret.configured;
  return {
    checkModel: draft.checkModel ?? undefined,
    description: draft.description ?? undefined,
    enabled: draft.enabled,
    // Platform runtime always executes server-side; never surface client-fetch as active.
    fetchOnClient: false,
    id: draft.providerKey,
    // Empty vaults — secretConfigured drives the "Configured" placeholder in ProviderConfig.
    keyVaults: {},
    logo: draft.logo ?? undefined,
    name: draft.displayName,
    secretConfigured,
    settings: (draft.settings ?? {}) as AiProviderDetailItem['settings'],
    source: draft.source === 'builtin' ? AiProviderSourceEnum.Builtin : AiProviderSourceEnum.Custom,
  };
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
): EnabledAiModel =>
  ({
    abilities: (item.abilities ?? {}) as EnabledAiModel['abilities'],
    config: item.config ?? undefined,
    contextWindowTokens: item.contextWindowTokens ?? undefined,
    description: item.description ?? undefined,
    displayName: item.displayName ?? undefined,
    enabled: item.enabled,
    id: item.modelKey,
    parameters: item.parameters ?? undefined,
    pricing: item.pricing ?? undefined,
    providerId: providerKey,
    settings: item.settings ?? undefined,
    sort: item.sort,
    source: 'custom',
    type: item.type,
  }) as EnabledAiModel;

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
