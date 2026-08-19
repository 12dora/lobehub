import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.thinking;
type ThinkingMode = (typeof EFFORT_CONTROL_REGISTRY)['thinking']['levels'][number];

// Display marks for the slider — this control reads as a mode (OFF / Auto / ON)
// rather than a strength, so it keeps its own labels instead of the raw levels.
const THINKING_MARKS = {
  0: 'OFF',
  1: 'Auto',
  2: 'ON',
};

export type ThinkingSliderProps = CreatedLevelSliderProps<ThinkingMode>;

const ThinkingSlider = createLevelSliderComponent<ThinkingMode>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  marks: THINKING_MARKS,
  style: { minWidth: 200 },
});

export default ThinkingSlider;
