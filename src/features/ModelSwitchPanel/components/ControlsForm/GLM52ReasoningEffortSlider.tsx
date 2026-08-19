import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.glm5_2ReasoningEffort;
type GLM52ReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['glm5_2ReasoningEffort']['levels'][number];

export type GLM52ReasoningEffortSliderProps = CreatedLevelSliderProps<GLM52ReasoningEffort>;

const GLM52ReasoningEffortSlider = createLevelSliderComponent<GLM52ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 160 },
});

export default GLM52ReasoningEffortSlider;
