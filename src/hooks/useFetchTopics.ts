import type { TopicQuerySortBy } from '@lobechat/types';

import { useAgentStore } from '@/store/agent';
import { builtinAgentSelectors } from '@/store/agent/selectors';
import { useChatStore } from '@/store/chat';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';

/**
 * Fetch topics for the current session (agent or group)
 */
export const useFetchTopics = (options?: {
  enabled?: boolean;
  excludeStatuses?: string[];
  excludeTriggers?: string[];
  /** Explicit agent session; prevents a route transition from reading stale Chat state. */
  session?: { agentId?: string; isInbox: boolean };
  sortBy?: TopicQuerySortBy;
}) => {
  const isInbox = useAgentStore(builtinAgentSelectors.isInboxAgent);
  const [activeAgentId, activeGroupId, useFetchTopicsHook] = useChatStore((s) => [
    s.activeAgentId,
    s.activeGroupId,
    s.useFetchTopics,
  ]);

  const topicPageSize = useGlobalStore(systemStatusSelectors.topicPageSize);
  const agentId = options?.session ? options.session.agentId : activeAgentId;
  const groupId = options?.session ? undefined : activeGroupId;
  const isInboxSession = options?.session ? options.session.isInbox : groupId ? false : isInbox;

  // If in group session, use groupId; otherwise use agentId
  const { isValidating, data } = useFetchTopicsHook(options?.enabled ?? true, {
    agentId,
    ...(options?.excludeStatuses && options.excludeStatuses.length > 0
      ? { excludeStatuses: options.excludeStatuses }
      : {}),
    ...(options?.excludeTriggers && options.excludeTriggers.length > 0
      ? { excludeTriggers: options.excludeTriggers }
      : {}),
    groupId,
    isInbox: isInboxSession,
    pageSize: topicPageSize,
    ...(options?.sortBy ? { sortBy: options.sortBy } : {}),
  });

  return {
    // isRevalidating: has cached data, updating in background
    isRevalidating: isValidating && !!data,
  };
};
