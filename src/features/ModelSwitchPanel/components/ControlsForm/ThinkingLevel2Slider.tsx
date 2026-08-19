import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.thinkingLevel2;
type ThinkingLevel2 = (typeof EFFORT_CONTROL_REGISTRY)['thinkingLevel2']['levels'][number];

export type ThinkingLevel2SliderProps = CreatedLevelSliderProps<ThinkingLevel2>;

const ThinkingLevel2Slider = createLevelSliderComponent<ThinkingLevel2>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 110 },
});

export default ThinkingLevel2Slider;
