import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.chatgptWebReasoningEffort;
type ChatGPTWebReasoningEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['chatgptWebReasoningEffort']['levels'][number];

export type ChatGPTWebReasoningEffortSliderProps =
  CreatedLevelSliderProps<ChatGPTWebReasoningEffort>;

export const ChatGPTWebReasoningEffortSlider =
  createLevelSliderComponent<ChatGPTWebReasoningEffort>({
    configKey,
    defaultValue: defaultLevel,
    levels,
    style: { minWidth: 270 },
  });
