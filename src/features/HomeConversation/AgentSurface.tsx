'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import { useFetchChatTopics } from '@/hooks/useFetchChatTopics';
import { useInitAgentConfig } from '@/hooks/useInitAgentConfig';
import HeaderSlot from '@/routes/(main)/agent/(chat)/_layout/HeaderSlot';
import Conversation from '@/routes/(main)/agent/features/Conversation';
import ChatHeader from '@/routes/(main)/agent/features/Conversation/Header';
import AgentWorkingSidebar from '@/routes/(main)/agent/features/Conversation/WorkingSidebar';
import Portal from '@/routes/(main)/agent/features/Portal';

interface AgentSurfaceProps {
  agentId: string;
}

/**
 * The real agent chat surface, re-hosted inside the home right column.
 *
 * Mirrors `agent/(chat)/_layout` + `agent/index.tsx` minus `ChatHydration`
 * (which would rewrite the URL to `/agent/:aid/:topicId`) and minus the agent
 * `_layout` chrome that belongs to the agent route (sidebar, hotkeys,
 * `AgentIdSync`, `ProtocolUrlHandler`, `PortalAutoCollapse`).
 *
 * It does have to take over one sidebar job: the topic fetch. `useFetchChatTopics`
 * normally rides along on the agent sidebar's topic list, which never mounts on
 * home — leaving `topicDataMap` empty, so the selected topic resolves to nothing
 * and the header reads "new topic", rename/delete/metadata go missing, and a
 * heterogeneous run loses the topic-bound working directory / session and falls
 * back to the agent default (i.e. Codex or Claude Code executing in the wrong
 * repo). Calling the *same* hook the sidebar calls keeps the SWR key identical,
 * so both surfaces share one `topicDataMap` bucket instead of racing it.
 */
const AgentSurface = memo<AgentSurfaceProps>(({ agentId }) => {
  // The home pathname carries no `:aid` param, so the id has to be passed in
  // explicitly — otherwise this falls back to a stale `activeAgentId`.
  useInitAgentConfig(agentId);
  useFetchChatTopics();

  return (
    <HeaderSlot.Provider>
      <Flexbox
        horizontal
        flex={1}
        height={'100%'}
        style={{ minHeight: 0, overflow: 'hidden', position: 'relative' }}
        width={'100%'}
      >
        <Flexbox flex={1} style={{ minHeight: 0, minWidth: 0 }}>
          <ChatHeader />
          <Flexbox flex={1} style={{ minHeight: 0, position: 'relative' }}>
            <Conversation />
          </Flexbox>
        </Flexbox>
        <Portal />
        <AgentWorkingSidebar />
      </Flexbox>
    </HeaderSlot.Provider>
  );
});

AgentSurface.displayName = 'HomeAgentSurface';

export default AgentSurface;
