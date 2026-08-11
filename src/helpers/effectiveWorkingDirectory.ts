import { isDesktop } from '@lobechat/const';

import { getAgentStoreState } from '@/store/agent';
import { agentByIdSelectors, agentSelectors } from '@/store/agent/selectors';
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
  agentId?: string,
  groupId?: string,
): string | undefined => {
  if (!isDesktop) return undefined;

  // Topic selectors normally read the active agent/group bucket. When an
  // operation identity is supplied, scope the lookup to that operation's
  // bucket instead of whichever conversation the user is currently viewing.
  const operationScopedState = agentId
    ? { ...chatState, activeAgentId: agentId, activeGroupId: groupId }
    : chatState;
  const topicWorkingDirectory =
    topicSelectors.getTopicWorkingDirectory(topicId)(operationScopedState);
  if (topicWorkingDirectory) return topicWorkingDirectory;

  const currentDeviceId = getElectronStoreState().gatewayDeviceInfo?.deviceId;
  if (agentId) {
    return (
      agentByIdSelectors.getAgentWorkingDirectoryById(
        agentId,
        currentDeviceId,
      )(getAgentStoreState()) ?? undefined
    );
  }

  return (
    agentSelectors.currentAgentWorkingDirectory(currentDeviceId)(getAgentStoreState()) ?? undefined
  );
};
