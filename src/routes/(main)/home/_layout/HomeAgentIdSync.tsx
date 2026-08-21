import { useLayoutEffect, useRef } from 'react';

import {
  type HomeConversationParams,
  useHomeConversationParams,
  useIsHomeRoute,
} from '@/features/HomeConversation/useHomeConversation';
import { useCurrentInboxAgentId } from '@/hooks/useCurrentInboxAgent';
import { useAgentStore } from '@/store/agent';

interface InboxAgentIdSyncProps {
  /**
   * The in-place conversation the home shell currently owns, if any. Present
   * means `HomeConversationHydration` is the authority on `activeAgentId`.
   */
  conversation: HomeConversationParams | null;
}

const InboxAgentIdSync = ({ conversation }: InboxAgentIdSyncProps) => {
  const inboxAgentId = useCurrentInboxAgentId();
  const previousInboxAgentIdRef = useRef<string | undefined>(undefined);
  // Read from the *unmount* cleanup, which has no access to the render-time
  // props of the commit that removed it.
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;

  // Sync inbox agent id to activeAgentId when on home page. Layout effect (not
  // passive) so it stays ordered with AgentIdSync's layout-effect clear/backfill:
  // in a single route-switch commit, removed-tree layout cleanups always run
  // before new-tree layout effects.
  useLayoutEffect(() => {
    // `/?agent=…` keeps the home pathname, but the conversation's hydrator owns
    // `activeAgentId` there. Forcing the inbox id would load the wrong thread
    // into the right column. Note `previousInboxAgentIdRef` is deliberately
    // left untouched: the id this component last claimed is still the one it
    // is responsible for releasing when home stops being the route.
    if (conversation) return;

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
  }, [conversation, inboxAgentId]);

  // Clear activeAgentId when unmounting (leaving home page) — layout cleanup
  // for the same ordering reason as above.
  useLayoutEffect(
    () => () => {
      const previousInboxAgentId = previousInboxAgentIdRef.current;
      if (!previousInboxAgentId) return;

      // An in-place conversation bound to the *same* agent (sending to the
      // inbox from the home composer is exactly this) already owns the id via
      // `HomeConversationHydration`. Clearing it here would blink it through
      // `undefined` inside the same commit — the frame where `AgentInfo` falls
      // back to a skeleton and `useAgentContext` keys `main_undefined_new`.
      if (conversationRef.current?.agentId === previousInboxAgentId) return;

      if (useAgentStore.getState().activeAgentId === previousInboxAgentId)
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
 *
 * Gate (2) is applied *inside* `InboxAgentIdSync` rather than by unmounting it.
 * Unmounting ran the release cleanup on the landing → `/?agent=<inbox>` seam —
 * the exact commit where the hydrator is claiming the same id — so
 * `activeAgentId` blinked through `undefined` and the right column's first
 * render keyed on `main_undefined_new`. Staying mounted keeps the release tied
 * to gate (1), which is the one that actually means "home is no longer the
 * route".
 */
const HomeAgentIdSync = () => {
  const isHomeRoute = useIsHomeRoute();
  const conversation = useHomeConversationParams();

  if (!isHomeRoute) return null;

  return <InboxAgentIdSync conversation={conversation} />;
};

export default HomeAgentIdSync;
