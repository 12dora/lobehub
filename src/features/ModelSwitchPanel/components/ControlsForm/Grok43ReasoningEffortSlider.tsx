import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.grok4_3ReasoningEffort;
type Grok43ReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['grok4_3ReasoningEffort']['levels'][number];

export type Grok43ReasoningEffortSliderProps = CreatedLevelSliderProps<Grok43ReasoningEffort>;

const Grok43ReasoningEffortSlider = createLevelSliderComponent<Grok43ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default Grok43ReasoningEffortSlider;
