import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.thinkingLevel4;
type ThinkingLevel4 = (typeof EFFORT_CONTROL_REGISTRY)['thinkingLevel4']['levels'][number];

export type ThinkingLevel4SliderProps = CreatedLevelSliderProps<ThinkingLevel4>;

const ThinkingLevel4Slider = createLevelSliderComponent<ThinkingLevel4>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 110 },
});

export default ThinkingLevel4Slider;
