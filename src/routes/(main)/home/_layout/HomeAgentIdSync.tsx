import { useLayoutEffect, useRef } from 'react';

import { useCurrentInboxAgentId } from '@/hooks/useCurrentInboxAgent';
import { useAgentStore } from '@/store/agent';

const HomeAgentIdSync = () => {
  const inboxAgentId = useCurrentInboxAgentId();
  const previousInboxAgentIdRef = useRef<string | undefined>(undefined);

  // Sync inbox agent id to activeAgentId when on home page. Layout effect (not
  // passive) so it stays ordered with AgentIdSync's layout-effect clear/backfill:
  // in a single route-switch commit, removed-tree layout cleanups always run
  // before new-tree layout effects.
  useLayoutEffect(() => {
    const previousInboxAgentId = previousInboxAgentIdRef.current;

    if (!inboxAgentId) {
      if (previousInboxAgentId && useAgentStore.getState().activeAgentId === previousInboxAgentId)
        useAgentStore.setState(
          { activeAgentId: undefined },
          false,
          'HomeAgentIdSync/clearStaleInbox',
        );
      return;
    }

    if (useAgentStore.getState().activeAgentId !== inboxAgentId)
      useAgentStore.setState({ activeAgentId: inboxAgentId }, false, 'HomeAgentIdSync/syncAgentId');

    previousInboxAgentIdRef.current = inboxAgentId;
  }, [inboxAgentId]);

  // Clear activeAgentId when unmounting (leaving home page) — layout cleanup
  // for the same ordering reason as above.
  useLayoutEffect(
    () => () => {
      const previousInboxAgentId = previousInboxAgentIdRef.current;
      if (previousInboxAgentId && useAgentStore.getState().activeAgentId === previousInboxAgentId)
        useAgentStore.setState(
          { activeAgentId: undefined },
          false,
          'HomeAgentIdSync/unmountAgentId',
        );
    },
    [],
  );

  return null;
};

export default HomeAgentIdSync;
