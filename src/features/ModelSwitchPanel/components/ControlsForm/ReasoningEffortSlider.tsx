import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.reasoningEffort;
type ReasoningEffort = (typeof EFFORT_CONTROL_REGISTRY)['reasoningEffort']['levels'][number];

export type ReasoningEffortSliderProps = CreatedLevelSliderProps<ReasoningEffort>;

const ReasoningEffortSlider = createLevelSliderComponent<ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default ReasoningEffortSlider;
