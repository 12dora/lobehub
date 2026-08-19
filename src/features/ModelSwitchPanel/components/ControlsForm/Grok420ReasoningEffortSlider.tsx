import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.grok4_20ReasoningEffort;
type Grok420ReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['grok4_20ReasoningEffort']['levels'][number];

export type Grok420ReasoningEffortSliderProps = CreatedLevelSliderProps<Grok420ReasoningEffort>;

const Grok420ReasoningEffortSlider = createLevelSliderComponent<Grok420ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default Grok420ReasoningEffortSlider;
