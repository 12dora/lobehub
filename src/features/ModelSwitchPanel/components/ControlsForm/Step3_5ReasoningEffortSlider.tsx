import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.step3_5ReasoningEffort;
type Step3_5ReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['step3_5ReasoningEffort']['levels'][number];

export type Step3_5ReasoningEffortSliderProps = CreatedLevelSliderProps<Step3_5ReasoningEffort>;

const Step3_5ReasoningEffortSlider = createLevelSliderComponent<Step3_5ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default Step3_5ReasoningEffortSlider;
