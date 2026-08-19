import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.effort;
type EffortLevel = (typeof EFFORT_CONTROL_REGISTRY)['effort']['levels'][number];

export type EffortSliderProps = CreatedLevelSliderProps<EffortLevel>;

const EffortSlider = createLevelSliderComponent<EffortLevel>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default EffortSlider;
