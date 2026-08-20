import { useLayoutEffect, useRef } from 'react';

import {
  useHomeConversationParams,
  useIsHomeRoute,
} from '@/features/HomeConversation/useHomeConversation';
import { useCurrentInboxAgentId } from '@/hooks/useCurrentInboxAgent';
import { useAgentStore } from '@/store/agent';

const InboxAgentIdSync = () => {
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

/**
 * Home owns `activeAgentId` only while home is *actually* the route and no
 * in-place conversation is open.
 *
 * Two gates, both load-bearing:
 *
 * 1. `isHomeRoute` — `DesktopHomeLayout` stays mounted on other routes via
 *    React 19 `<Activity>`, and Activity destroys effects only when it flips to
 *    `hidden`, i.e. `HOME_FADE_MS` *after* the navigation commit. Ungated, the
 *    unmount cleanup below would land long after the agent route's
 *    `AgentIdSync` layout effect and clear the freshly routed id — leaving the
 *    agent sidebar identity chip on a skeleton forever
 *    (`agentSelectors.isAgentConfigLoading` is `!activeAgentId`). Rendering
 *    `null` the moment the pathname stops being home moves that cleanup back
 *    into the navigation commit, where removed-tree layout cleanups are
 *    guaranteed to run *before* the new tree's layout effects.
 * 2. no home conversation params — `/?agent=…&topic=…` keeps the home pathname,
 *    so gate (1) is still true, but the active agent belongs to the
 *    conversation. Forcing the inbox id here would load the wrong thread in the
 *    right column.
 */
const HomeAgentIdSync = () => {
  const isHomeRoute = useIsHomeRoute();
  const conversation = useHomeConversationParams();

  if (!isHomeRoute || conversation) return null;

  return <InboxAgentIdSync />;
};

export default HomeAgentIdSync;
