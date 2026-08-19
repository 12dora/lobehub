import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.gpt5_6ReasoningEffort;
type GPT56ReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['gpt5_6ReasoningEffort']['levels'][number];

export type GPT56ReasoningEffortSliderProps = CreatedLevelSliderProps<GPT56ReasoningEffort>;

export const GPT56ReasoningEffortSlider = createLevelSliderComponent<GPT56ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 270 },
});
