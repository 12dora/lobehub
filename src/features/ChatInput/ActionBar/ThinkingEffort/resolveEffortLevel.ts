import type {
  EffortControlDefinition,
  EffortControlKey,
  EffortLevel,
} from '@lobechat/model-runtime';
import { clampEffortLevel, resolveDefaultThinkingLevelForModel } from '@lobechat/model-runtime';
import type { LobeAgentChatConfig } from '@lobechat/types';

export interface EffortControlContext {
  definition: EffortControlDefinition;
  key: EffortControlKey;
  model?: string;
}

const isOffered = (definition: EffortControlDefinition, level: string) =>
  (definition.levels as readonly string[]).includes(level);

/**
 * The level a control shows before the user has ever picked one.
 *
 * `EffortControlDefinition.defaultLevel` covers the static case; this adds the two
 * model-specific overrides the registry table cannot express, mirroring
 * `ControlsForm.tsx` so the quick selector and the slider never disagree:
 *
 * - `thinkingLevel` follows `resolveDefaultThinkingLevelForModel` (Gemini flash
 *   variants default lower). Only `thinkingLevel` is affected — the runtime's
 *   `thinkingLevel2/3/4` defaults are already what the registry stores, and
 *   `ControlsForm` likewise passes the resolved value to `ThinkingLevelSlider` only.
 * - `gpt5_2ReasoningEffort` defaults to `medium` on `gpt-5.5`.
 */
export const resolveDefaultEffortLevel = ({
  definition,
  key,
  model,
}: EffortControlContext): EffortLevel => {
  if (key === 'thinkingLevel') {
    const modelDefault = resolveDefaultThinkingLevelForModel(model);
    if (modelDefault && isOffered(definition, modelDefault)) return modelDefault;
  }

  if (key === 'gpt5_2ReasoningEffort' && model === 'gpt-5.5' && isOffered(definition, 'medium')) {
    return 'medium';
  }

  return definition.defaultLevel;
};

/**
 * The level to render as selected: the persisted value when the control still
 * offers it, otherwise the (possibly model-specific) default.
 */
export const resolveCurrentEffortLevel = ({
  config,
  definition,
  key,
  model,
}: EffortControlContext & { config?: LobeAgentChatConfig }): EffortLevel => {
  const stored = config?.[definition.configKey];

  if (typeof stored === 'string' && isOffered(definition, stored)) {
    return clampEffortLevel(definition, stored);
  }

  return resolveDefaultEffortLevel({ definition, key, model });
};
