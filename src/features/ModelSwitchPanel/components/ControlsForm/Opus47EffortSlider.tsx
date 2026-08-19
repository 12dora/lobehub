import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.opus47Effort;
type Opus47Effort = (typeof EFFORT_CONTROL_REGISTRY)['opus47Effort']['levels'][number];

export type Opus47EffortSliderProps = CreatedLevelSliderProps<Opus47Effort>;

const Opus47EffortSlider = createLevelSliderComponent<Opus47Effort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default Opus47EffortSlider;
