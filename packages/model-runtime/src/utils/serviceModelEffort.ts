import type { LobeAgentChatConfig } from '@lobechat/types';

import type { GenerateObjectEffortParams } from '../types/structureOutput';
import { clampEffortLevel, findEffortControl } from './effortControlRegistry';
import { applyModelExtendParams, type ModelExtendParams } from './modelExtendParams';

const GENERATE_OBJECT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const GENERATE_OBJECT_REASONING_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
const GENERATE_OBJECT_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
const GENERATE_OBJECT_THINKING_TYPES = ['enabled', 'disabled', 'adaptive'] as const;

const isOneOf = <T extends string>(value: string, allowed: readonly T[]): value is T =>
  (allowed as readonly string[]).includes(value);

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
 * Copy only defined, wire-valid effort fields so callers can spread onto
 * generateObject without leaking settings-only keys or unknown enum values.
 */
export const pickGenerateObjectEffortParams = (
  source: Pick<ModelExtendParams, 'effort' | 'reasoning_effort' | 'thinking' | 'thinkingLevel'>,
): GenerateObjectEffortParams => {
  const params: GenerateObjectEffortParams = {};

  if (typeof source.effort === 'string' && isOneOf(source.effort, GENERATE_OBJECT_EFFORT_LEVELS)) {
    params.effort = source.effort;
  }

  if (
    typeof source.reasoning_effort === 'string' &&
    isOneOf(source.reasoning_effort, GENERATE_OBJECT_REASONING_EFFORT_LEVELS)
  ) {
    params.reasoning_effort = source.reasoning_effort;
  }

  if (source.thinking) {
    const thinkingType =
      typeof source.thinking.type === 'string' &&
      isOneOf(source.thinking.type, GENERATE_OBJECT_THINKING_TYPES)
        ? source.thinking.type
        : undefined;

    if (thinkingType !== undefined || source.thinking.budget_tokens !== undefined) {
      params.thinking = {
        ...(source.thinking.budget_tokens !== undefined
          ? { budget_tokens: source.thinking.budget_tokens }
          : {}),
        ...(thinkingType !== undefined ? { type: thinkingType } : {}),
      };
    }
  }

  if (
    typeof source.thinkingLevel === 'string' &&
    isOneOf(source.thinkingLevel, GENERATE_OBJECT_THINKING_LEVELS)
  ) {
    params.thinkingLevel = source.thinkingLevel;
  }

  return params;
};
