import type { ModelExtendParams } from '@lobechat/model-runtime';
import { projectServiceModelEffort } from '@lobechat/model-runtime';

import { aiModelSelectors, getAiInfraStoreState } from '@/store/aiInfra';
import type { SystemAgentItem } from '@/types/user/settings';

/**
 * Translate a service model's stored `reasoningEffort` into wire params.
 *
 * Looks up `settings.extendParams` from the client aiInfra store, then delegates
 * to the store-agnostic `projectServiceModelEffort` projector. Returns `{}` when
 * the level is unset/`null` or the model exposes no discrete effort control.
 */
export const resolveSystemAgentEffortParams = (
  item: Pick<SystemAgentItem, 'model' | 'provider' | 'reasoningEffort'> | undefined,
): ModelExtendParams => {
  // `null` is a stored clear ("use the provider default") and reads exactly like absent.
  if (!item?.reasoningEffort) return {};

  const { model, provider, reasoningEffort } = item;
  const extendParams = aiModelSelectors.modelExtendParams(model, provider)(getAiInfraStoreState());

  return projectServiceModelEffort({ extendParams, model, reasoningEffort });
};

/**
 * Request params for a call site that merges a whole `SystemAgentItem` into its payload.
 *
 * `reasoningEffort` is a settings-only field — those merge sites put every key they are
 * given straight on the wire, and strict upstreams reject unknown params — so it is
 * replaced by the provider-shaped params it resolves to.
 */
export const withSystemAgentEffortParams = <T extends SystemAgentItem>(
  item: T | undefined,
): Partial<Omit<T, 'reasoningEffort'>> & ModelExtendParams => {
  // Callers spread the result into a `merge(...)`, which already treated a missing
  // service-model config as "no params" — keep that shape rather than throwing.
  if (!item) return {};

  const { reasoningEffort: _settingOnly, ...wire } = item;

  return { ...wire, ...resolveSystemAgentEffortParams(item) };
};
