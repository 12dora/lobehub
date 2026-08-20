import type { LobeAgentChatConfig } from '@lobechat/types';

import type { GenerateObjectEffortParams } from '../types/structureOutput';
import { clampEffortLevel, findEffortControl } from './effortControlRegistry';
import { applyModelExtendParams, type ModelExtendParams } from './modelExtendParams';

export interface ProjectServiceModelEffortParams {
  extendParams: readonly string[] | undefined;
  model: string;
  reasoningEffort?: string | null;
}

/**
 * Translate a stored service-model `reasoningEffort` into provider-shaped wire params.
 *
 * Service models (topic naming, history compression, translation, …) do not own a
 * `chatConfig`, so the stored level is projected onto a synthetic one keyed by whatever
 * `configKey` the selected model's effort control declares, then run through the same
 * `applyModelExtendParams` the chat path uses. That keeps one provider-shape mapping.
 *
 * Returns `{}` — never a partial guess — when the level is unset/`null` or the model
 * exposes no discrete effort control, so callers can spread it unconditionally.
 *
 * Only the single matched control key is projected. Handing the model's full
 * `extendParams` list would make absence look like an explicit choice — e.g. a
 * Claude card offering both `enableReasoning` and `effort` would emit
 * `thinking: { type: 'disabled' }` alongside the effort we asked for.
 */
export const projectServiceModelEffort = (
  params: ProjectServiceModelEffortParams,
): ModelExtendParams => {
  if (!params.reasoningEffort) return {};

  const control = findEffortControl(params.extendParams);
  if (!control) return {};

  const chatConfig = {
    [control.definition.configKey]: clampEffortLevel(control.definition, params.reasoningEffort),
  } as LobeAgentChatConfig;

  return applyModelExtendParams({
    chatConfig,
    extendParams: [control.key],
    model: params.model,
  });
};

/**
 * Copy only defined effort wire fields so callers can spread onto generateObject
 * without emitting `effort: undefined` keys that strict equality tests (and some
 * serializers) treat as present.
 */
export const pickGenerateObjectEffortParams = (
  source: Pick<ModelExtendParams, 'effort' | 'reasoning_effort' | 'thinking' | 'thinkingLevel'>,
): GenerateObjectEffortParams => ({
  ...(source.effort !== undefined
    ? { effort: source.effort as GenerateObjectEffortParams['effort'] }
    : {}),
  ...(source.reasoning_effort !== undefined
    ? {
        reasoning_effort: source.reasoning_effort as GenerateObjectEffortParams['reasoning_effort'],
      }
    : {}),
  ...(source.thinking !== undefined ? { thinking: source.thinking } : {}),
  ...(source.thinkingLevel !== undefined
    ? { thinkingLevel: source.thinkingLevel as GenerateObjectEffortParams['thinkingLevel'] }
    : {}),
});
