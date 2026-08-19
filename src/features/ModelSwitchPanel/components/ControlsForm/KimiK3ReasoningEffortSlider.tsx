import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.kimiK3ReasoningEffort;
type KimiK3ReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['kimiK3ReasoningEffort']['levels'][number];

export type KimiK3ReasoningEffortSliderProps = CreatedLevelSliderProps<KimiK3ReasoningEffort>;

export const KimiK3ReasoningEffortSlider = createLevelSliderComponent<KimiK3ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});
