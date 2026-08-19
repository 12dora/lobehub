import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.codexMaxReasoningEffort;
type CodexMaxReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['codexMaxReasoningEffort']['levels'][number];

export type CodexMaxReasoningEffortSliderProps = CreatedLevelSliderProps<CodexMaxReasoningEffort>;

const CodexMaxReasoningEffortSlider = createLevelSliderComponent<CodexMaxReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default CodexMaxReasoningEffortSlider;
