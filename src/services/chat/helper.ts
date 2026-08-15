import type { EnabledAiModel } from 'model-bank';
import { ModelProvider } from 'model-bank';
import { isProviderNativeFileInput } from 'model-bank/modelProviders';

import { getAiInfraStoreState } from '@/store/aiInfra';
import { aiProviderSelectors } from '@/store/aiInfra/selectors';

export const getEnabledRuntimeModel = (
  model: string,
  provider: string,
): EnabledAiModel | undefined => {
  const state = getAiInfraStoreState();
  const exactModel = state.enabledAiModels?.find(
    (item) => item.id === model && item.providerId === provider,
  );

  if (exactModel || provider !== ModelProvider.LobeHub) return exactModel;

  return state.enabledAiModels?.find((item) => item.id === model);
};

const getModelAbilities = (model: string, provider: string) => {
  return getEnabledRuntimeModel(model, provider)?.abilities;
};

export const isCanUseVision = (model: string, provider: string): boolean => {
  return getModelAbilities(model, provider)?.vision || false;
};

/**
 * Whether the model accepts user documents natively (as a `file_url` content
 * part) instead of the `<files_info>` text injection.
 *
 * Requires BOTH the model ability and a provider runtime that implements the
 * native wire format: `abilities.files` alone is already set by catalogs whose
 * providers have no file part (e.g. OpenCode Zen), and emitting `file_url`
 * there would silently drop the document from the prompt.
 *
 * Invariant relied on downstream: only providers in the native set can ever
 * receive a `file_url` part, so runtimes that pass their payload through
 * verbatim (azureai, cloudflare, …) never see one.
 */
export const isCanUseFiles = (model: string, provider: string): boolean => {
  if (!isProviderNativeFileInput(provider)) return false;

  return getModelAbilities(model, provider)?.files || false;
};

export const isCanUseVideo = (model: string, provider: string): boolean => {
  return getModelAbilities(model, provider)?.video || false;
};

export const isCanUseAudio = (model: string, provider: string): boolean => {
  return getModelAbilities(model, provider)?.audio || false;
};

export const getRuntimeModelKnowledgeCutoff = (
  model: string,
  provider: string,
): string | undefined => getEnabledRuntimeModel(model, provider)?.knowledgeCutoff;

export const getRuntimeModelDisplayName = (model: string, provider: string): string | undefined =>
  getEnabledRuntimeModel(model, provider)?.displayName;

/**
 * TODO: we need to update this function to auto find deploymentName with provider setting config
 */
export const findDeploymentName = (model: string, provider: string) => {
  let deploymentId = model;

  // find the model by id
  const modelItem = getAiInfraStoreState().enabledAiModels?.find(
    (i) => i.id === model && i.providerId === provider,
  );

  if (modelItem && modelItem.config?.deploymentName) {
    deploymentId = modelItem.config?.deploymentName;
  }

  return deploymentId;
};

export const isEnableFetchOnClient = (provider: string) => {
  return aiProviderSelectors.isProviderFetchOnClient(provider)(getAiInfraStoreState());
};

export const resolveRuntimeProvider = (provider: string) => {
  const isBuiltin = Object.values(ModelProvider).includes(provider as any);
  if (isBuiltin) return provider;

  const providerConfig = aiProviderSelectors.providerConfigById(provider)(getAiInfraStoreState());

  return providerConfig?.settings.sdkType || 'openai';
};
