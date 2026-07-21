'use client';

import isEqual from 'fast-deep-equal';
import { useMemo } from 'react';

import { useAgentStore } from '@/store/agent';
import { builtinAgentSelectors } from '@/store/agent/selectors';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';
import { useHomeStore } from '@/store/home';
import { homeAgentListSelectors } from '@/store/home/selectors';

// SWR subscription is owned by the caller of AgentListContent (Body/Agent
// accordion, or the standalone SwitchPanel). Subscribing here would re-fetch
// on every accordion expand and flash spinners across the sidebar.
export const useAgentList = (limitDefault = true) => {
  const agentPageSize = useGlobalStore(systemStatusSelectors.agentPageSize);
  const ungroupedAgents = useHomeStore(
    limitDefault
      ? homeAgentListSelectors.ungroupedAgentsLimited(agentPageSize)
      : homeAgentListSelectors.ungroupedAgents,
    isEqual,
  );
  const agentGroups = useHomeStore(homeAgentListSelectors.agentGroups, isEqual);
  const pinnedAgents = useHomeStore(homeAgentListSelectors.pinnedAgents, isEqual);
  const privateAgentGroups = useHomeStore(homeAgentListSelectors.privateAgentGroups, isEqual);
  const privateUngroupedAgents = useHomeStore(
    homeAgentListSelectors.privateUngroupedAgents,
    isEqual,
  );
  // Resolved builtin inbox agent id. When ENABLE_PLATFORM_MANAGED_AGENTS is on, the server injects
  // the builtin inbox into the ungrouped bucket as an ordinary managed row carrying this same real
  // agent id — which would render the inbox a second time alongside the dedicated top `InboxItem`.
  const inboxAgentId = useAgentStore(builtinAgentSelectors.inboxAgentId);

  return useMemo(() => {
    // Drop the injected inbox row so the inbox only surfaces once (via the canonical `InboxItem`).
    // No-op when the flag is off (no injected row) or before the inbox id resolves.
    const dropInbox = <T extends { id: string }>(list: T[]): T[] =>
      inboxAgentId ? list.filter((item) => item.id !== inboxAgentId) : list;

    return {
      customList: agentGroups,
      defaultList: dropInbox(ungroupedAgents),
      pinnedList: dropInbox(pinnedAgents),
      privateGroupList: privateAgentGroups,
      privateUngroupedList: privateUngroupedAgents,
    };
  }, [
    agentGroups,
    pinnedAgents,
    ungroupedAgents,
    privateAgentGroups,
    privateUngroupedAgents,
    inboxAgentId,
  ]);
};
