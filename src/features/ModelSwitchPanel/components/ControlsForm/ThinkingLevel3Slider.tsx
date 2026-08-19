import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.thinkingLevel3;
type ThinkingLevel3 = (typeof EFFORT_CONTROL_REGISTRY)['thinkingLevel3']['levels'][number];

export type ThinkingLevel3SliderProps = CreatedLevelSliderProps<ThinkingLevel3>;

const ThinkingLevel3Slider = createLevelSliderComponent<ThinkingLevel3>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 160 },
});

export default ThinkingLevel3Slider;
