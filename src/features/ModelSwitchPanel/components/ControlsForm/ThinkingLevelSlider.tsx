import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.thinkingLevel;
type ThinkingLevel = (typeof EFFORT_CONTROL_REGISTRY)['thinkingLevel']['levels'][number];

export type ThinkingLevelSliderProps = CreatedLevelSliderProps<ThinkingLevel>;

const ThinkingLevelSlider = createLevelSliderComponent<ThinkingLevel>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default ThinkingLevelSlider;
