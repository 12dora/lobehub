import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.hy3ReasoningEffort;
type Hy3ReasoningEffort = (typeof EFFORT_CONTROL_REGISTRY)['hy3ReasoningEffort']['levels'][number];

export type Hy3ReasoningEffortSliderProps = CreatedLevelSliderProps<Hy3ReasoningEffort>;

const Hy3ReasoningEffortSlider = createLevelSliderComponent<Hy3ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default Hy3ReasoningEffortSlider;
