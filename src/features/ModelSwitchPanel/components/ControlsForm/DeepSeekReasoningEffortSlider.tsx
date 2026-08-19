import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.deepseekV4ReasoningEffort;
type DeepSeekReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['deepseekV4ReasoningEffort']['levels'][number];

export type DeepSeekReasoningEffortSliderProps = CreatedLevelSliderProps<DeepSeekReasoningEffort>;

const DeepSeekReasoningEffortSlider = createLevelSliderComponent<DeepSeekReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 180 },
});

export default DeepSeekReasoningEffortSlider;
