import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

// Grok 4.5 reasoning is always on: low/medium/high (no 'none'), default high.
const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.grok4_5ReasoningEffort;
type Grok45ReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['grok4_5ReasoningEffort']['levels'][number];

export type Grok45ReasoningEffortSliderProps = CreatedLevelSliderProps<Grok45ReasoningEffort>;

const Grok45ReasoningEffortSlider = createLevelSliderComponent<Grok45ReasoningEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 200 },
});

export default Grok45ReasoningEffortSlider;
