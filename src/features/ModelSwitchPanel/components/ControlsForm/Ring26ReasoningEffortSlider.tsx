import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.ring2_6ReasoningEffort;
type Ring26ReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['ring2_6ReasoningEffort']['levels'][number];

export type Ring26ReasoningEffortSliderProps = CreatedLevelSliderProps<Ring26ReasoningEffort>;

const Ring26ReasoningEffortSlider = createLevelSliderComponent<Ring26ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default Ring26ReasoningEffortSlider;
