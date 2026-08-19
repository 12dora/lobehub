import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.gpt5ReasoningEffort;
type GPT5ReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['gpt5ReasoningEffort']['levels'][number];

export type GPT5ReasoningEffortSliderProps = CreatedLevelSliderProps<GPT5ReasoningEffort>;

const GPT5ReasoningEffortSlider = createLevelSliderComponent<GPT5ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default GPT5ReasoningEffortSlider;
