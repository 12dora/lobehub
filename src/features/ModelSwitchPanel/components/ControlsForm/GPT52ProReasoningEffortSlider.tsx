import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.gpt5_2ProReasoningEffort;
type GPT52ProReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['gpt5_2ProReasoningEffort']['levels'][number];

export type GPT52ProReasoningEffortSliderProps = CreatedLevelSliderProps<GPT52ProReasoningEffort>;

const GPT52ProReasoningEffortSlider = createLevelSliderComponent<GPT52ProReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 160 },
});

export default GPT52ProReasoningEffortSlider;
