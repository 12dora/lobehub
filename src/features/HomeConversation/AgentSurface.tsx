'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

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
 */
const AgentSurface = memo<AgentSurfaceProps>(({ agentId }) => {
  // The home pathname carries no `:aid` param, so the id has to be passed in
  // explicitly — otherwise this falls back to a stale `activeAgentId`.
  useInitAgentConfig(agentId);

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
