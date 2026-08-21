import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.chatgptWebThinkingEffort;
type ChatGPTWebThinkingEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['chatgptWebThinkingEffort']['levels'][number];

export type ChatGPTWebThinkingEffortSliderProps = CreatedLevelSliderProps<ChatGPTWebThinkingEffort>;

export const ChatGPTWebThinkingEffortSlider = createLevelSliderComponent<ChatGPTWebThinkingEffort>({
  configKey,
  defaultValue: defaultLevel,
  levels,
  style: { minWidth: 220 },
});
