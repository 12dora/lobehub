import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.gpt5_2ReasoningEffort;
type GPT52ReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['gpt5_2ReasoningEffort']['levels'][number];

export type GPT52ReasoningEffortSliderProps = CreatedLevelSliderProps<GPT52ReasoningEffort>;

const GPT52ReasoningEffortSlider = createLevelSliderComponent<GPT52ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 230 },
});

export default GPT52ReasoningEffortSlider;
