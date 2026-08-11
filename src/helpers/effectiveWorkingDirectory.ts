import { isDesktop } from '@lobechat/const';

import { getAgentStoreState } from '@/store/agent';
import { agentSelectors } from '@/store/agent/selectors';
import type { ChatStoreState } from '@/store/chat/initialState';
import { topicSelectors } from '@/store/chat/selectors';
import { getElectronStoreState } from '@/store/electron';

/**
 * Resolve the topic override, then the agent's per-device working directory.
 * Chat state is passed in so agent-run transports can use this without importing
 * the chat store instance and creating a module cycle.
 */
export const resolveEffectiveWorkingDirectory = (
  chatState: ChatStoreState,
  topicId?: string | null,
): string | undefined => {
  if (!isDesktop) return undefined;

  const topicWorkingDirectory = topicSelectors.getTopicWorkingDirectory(topicId)(chatState);
  if (topicWorkingDirectory) return topicWorkingDirectory;

  const currentDeviceId = getElectronStoreState().gatewayDeviceInfo?.deviceId;
  return (
    agentSelectors.currentAgentWorkingDirectory(currentDeviceId)(getAgentStoreState()) ?? undefined
  );
};
