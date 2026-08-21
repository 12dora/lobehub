import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';

import { type CreatedLevelSliderProps, createLevelSliderComponent } from './createLevelSlider';

const { configKey, defaultLevel, levels } = EFFORT_CONTROL_REGISTRY.chatgptWebProThinkingEffort;
type ChatGPTWebProThinkingEffort =
  (typeof EFFORT_CONTROL_REGISTRY)['chatgptWebProThinkingEffort']['levels'][number];

export type ChatGPTWebProThinkingEffortSliderProps =
  CreatedLevelSliderProps<ChatGPTWebProThinkingEffort>;

/**
 * Pro only accepts `standard` on the wire. A 1-level slider would be an empty
 * track, so `LevelSlider` renders the single selected label instead.
 */
export const ChatGPTWebProThinkingEffortSlider =
  createLevelSliderComponent<ChatGPTWebProThinkingEffort>({
    configKey,
    defaultValue: defaultLevel,
    levels,
  });
