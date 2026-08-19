import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.gpt5_1ReasoningEffort;
type GPT51ReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['gpt5_1ReasoningEffort']['levels'][number];

export type GPT51ReasoningEffortSliderProps = CreatedLevelSliderProps<GPT51ReasoningEffort>;

const GPT51ReasoningEffortSlider = createLevelSliderComponent<GPT51ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default GPT51ReasoningEffortSlider;
