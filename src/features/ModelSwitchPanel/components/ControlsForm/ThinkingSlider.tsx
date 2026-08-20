import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.thinking;
type ThinkingMode = (typeof EFFORT_CONTROL_REGISTRY)['thinking']['levels'][number];

export type ThinkingSliderProps = CreatedLevelSliderProps<ThinkingMode>;

// No custom marks: the `disabled` / `auto` / `enabled` levels are named by the shared
// `serviceModel.reasoningEffort.options.*` copy, so this tri-state reads the same here,
// in the in-chat pill and in the service-model picker. Hardcoded OFF / Auto / ON marks
// were both untranslated and a third wording for the same three values.
const ThinkingSlider = createLevelSliderComponent<ThinkingMode>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default ThinkingSlider;
