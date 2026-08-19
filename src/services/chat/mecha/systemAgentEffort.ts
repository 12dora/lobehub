import type { ModelExtendParams } from '@lobechat/model-runtime';
import {
  applyModelExtendParams,
  clampEffortLevel,
  findEffortControl,
} from '@lobechat/model-runtime';
import type { LobeAgentChatConfig } from '@lobechat/types';

import { aiModelSelectors, getAiInfraStoreState } from '@/store/aiInfra';
import type { SystemAgentItem } from '@/types/user/settings';

/**
 * Translate a service model's stored `reasoningEffort` into wire params.
 *
 * Service models (topic naming, history compression, translation, …) do not own a
 * `chatConfig`, so the stored level is projected onto a synthetic one keyed by whatever
 * `configKey` the selected model's effort control declares, then run through the same
 * `applyModelExtendParams` the chat path uses. That keeps one provider-shape mapping.
 *
 * Returns `{}` — never a partial guess — when the level is unset or the model exposes no
 * discrete effort control, so callers can spread it unconditionally.
 */
export const resolveSystemAgentEffortParams = (
  item: Pick<SystemAgentItem, 'model' | 'provider' | 'reasoningEffort'> | undefined,
): ModelExtendParams => {
  // `null` is a stored clear ("use the provider default") and reads exactly like absent.
  if (!item?.reasoningEffort) return {};

  const { model, provider, reasoningEffort } = item;
  const extendParams = aiModelSelectors.modelExtendParams(model, provider)(getAiInfraStoreState());
  const control = findEffortControl(extendParams);

  if (!control) return {};

  // Clamp: the stored level may predate a model swap that no longer offers it.
  const chatConfig = {
    [control.definition.configKey]: clampEffortLevel(control.definition, reasoningEffort),
  } as LobeAgentChatConfig;

  // Project ONLY the resolved control, never the model's full extendParams list. The projector
  // reads every param it is handed against this chatConfig, and a sparse chatConfig makes
  // absence look like an explicit choice — e.g. a model offering both `enableReasoning` and
  // `effort` would emit `thinking: { type: 'disabled' }` alongside the effort we asked for,
  // contradicting itself. A service model only ever configures its one effort control.
  return applyModelExtendParams({ chatConfig, extendParams: [control.key], model });
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
