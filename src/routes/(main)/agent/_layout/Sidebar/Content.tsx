import React, { memo } from 'react';

import SideBarLayout from '@/features/NavPanel/SideBarLayout';
import { useInitAgentConfig } from '@/hooks/useInitAgentConfig';

import Body from './Body';
import Header from './Header';
import { useRoutedAgentId } from './Header/Agent/useRoutedAgentId';

const AgentSidebarContent = memo(() => {
  const routedAgentId = useRoutedAgentId();

  // Start the config fetch from the sidebar itself. On a client navigation the
  // NavPanel paints this fallback before the lazy agent layout (and its own
  // `useInitAgentConfig`) has loaded; without this the header would sit on a
  // placeholder until that chunk lands. SWR dedupes the second subscriber, and
  // `useFetchAgentConfig` only adopts `activeAgentId` when nothing is active,
  // so this cannot hijack the routed agent.
  useInitAgentConfig(routedAgentId);

  return <SideBarLayout body={<Body />} header={<Header />} />;
});

AgentSidebarContent.displayName = 'AgentSidebarContent';

export default AgentSidebarContent;
