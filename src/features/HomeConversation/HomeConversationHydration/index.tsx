'use client';

import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

import { useClearActiveTopicUnread } from '@/features/Conversation/hooks';
import { useAgentStore } from '@/store/agent';
import { useAgentGroupStore } from '@/store/agentGroup';
import { useChatStore } from '@/store/chat';

import {
  HOME_CONVERSATION_TOPIC_PARAM,
  homeConversationSearchParams,
  homeConversationTargetFromChatPath,
} from '../homeConversationPath';
import { type HomeConversationParams, useActiveHomeConversation } from '../useHomeConversation';

/**
 * Home-shell counterpart of `agent/features/Conversation/ChatHydration`.
 *
 * The agent hydrator is **not reusable here**: its store subscriber rewrites the
 * URL to `AGENT_CHAT_TOPIC_URL` (`/agent/:aid/:topicId`), which is exactly the
 * pathname change that swaps the left nav away from home. This one keeps the
 * current (home) pathname and only rewrites the `topic` search param.
 */
const Hydration = memo<HomeConversationParams>(({ agentId, groupId, topicId }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // Hydration writes `activeTopicId` directly (below) instead of going through
  // `switchTopic`, so clear any lingering persisted unread once the topic loads.
  useClearActiveTopicUnread();

  const locationRef = useRef(location);
  const searchParamsRef = useRef(searchParams);
  locationRef.current = location;
  searchParamsRef.current = searchParams;

  // Agent conversation: own `activeAgentId` in both stores while mounted.
  useLayoutEffect(() => {
    if (!agentId) return;

    if (useAgentStore.getState().activeAgentId !== agentId)
      useAgentStore.setState(
        { activeAgentId: agentId },
        false,
        'HomeConversationHydration/syncAgentId',
      );

    if (useChatStore.getState().activeAgentId !== agentId)
      useChatStore.setState(
        { activeAgentId: agentId },
        false,
        'HomeConversationHydration/syncAgentId',
      );

    // Layout cleanup (not passive): leaving home runs this in the navigation
    // commit, before the agent route's `AgentIdSync` layout effect — so the
    // routed id always wins. The `===` guards keep it from clearing an id
    // somebody else already claimed.
    return () => {
      if (useAgentStore.getState().activeAgentId === agentId)
        useAgentStore.setState(
          { activeAgentId: undefined },
          false,
          'HomeConversationHydration/clearAgentId',
        );

      if (useChatStore.getState().activeAgentId === agentId)
        useChatStore.setState(
          { activeAgentId: undefined },
          false,
          'HomeConversationHydration/clearAgentId',
        );
    };
  }, [agentId]);

  /**
   * `agentGroupStore.switchTopic` navigates through the injected `router`, and
   * it always targets `GROUP_CHAT_TOPIC_URL`. Translating those targets back to
   * the current pathname + search params is what keeps a group conversation
   * from ejecting itself to `/group/...` (and out of the home nav).
   */
  const homeRouter = useMemo(() => {
    const toHomeUrl = (url: string) => {
      const target = homeConversationTargetFromChatPath(url);
      if (!target) return url;

      const nextParams = homeConversationSearchParams(target);
      if (!nextParams) return url;

      const search = nextParams.toString();
      return `${locationRef.current.pathname}${search ? `?${search}` : ''}`;
    };

    return {
      push: (url: string, options?: { replace?: boolean }) =>
        navigate(toHomeUrl(url), { replace: options?.replace }),
    };
  }, [navigate]);

  // Group conversation: own `activeGroupId` + the navigation adapter.
  useLayoutEffect(() => {
    if (!groupId) return;

    useAgentGroupStore.setState(
      { activeGroupId: groupId, router: homeRouter },
      false,
      'HomeConversationHydration/syncGroupId',
    );

    if (useChatStore.getState().activeGroupId !== groupId)
      useChatStore.setState(
        { activeGroupId: groupId },
        false,
        'HomeConversationHydration/syncGroupId',
      );

    return () => {
      if (useAgentGroupStore.getState().activeGroupId === groupId)
        useAgentGroupStore.setState(
          { activeGroupId: undefined, router: undefined },
          false,
          'HomeConversationHydration/clearGroupId',
        );

      if (useChatStore.getState().activeGroupId === groupId)
        useChatStore.setState(
          { activeGroupId: undefined },
          false,
          'HomeConversationHydration/clearGroupId',
        );
    };
  }, [groupId, homeRouter]);

  // Search params → store.
  useLayoutEffect(() => {
    const target = topicId ?? null;
    if (useChatStore.getState().activeTopicId !== target)
      useChatStore.setState(
        { activeTopicId: target! },
        false,
        'HomeConversationHydration/syncTopicFromUrl',
      );
  }, [topicId]);

  // Store → search params. Never a pathname change: the home pathname is what
  // keeps the home nav, the home overlay and the `home` RouteTransition key.
  useLayoutEffect(() => {
    const unsubscribe = useChatStore.subscribe(
      (s) => s.activeTopicId,
      (nextTopicId) => {
        const nextSearchParams = new URLSearchParams(searchParamsRef.current);

        if (nextTopicId) nextSearchParams.set(HOME_CONVERSATION_TOPIC_PARAM, nextTopicId);
        else nextSearchParams.delete(HOME_CONVERSATION_TOPIC_PARAM);

        const search = nextSearchParams.toString();
        const { pathname, hash } = locationRef.current;
        const nextUrl = `${pathname}${search ? `?${search}` : ''}${hash ?? ''}`;
        const currentUrl = `${pathname}${locationRef.current.search ?? ''}${hash ?? ''}`;

        if (currentUrl !== nextUrl) navigate(nextUrl, { replace: true });
      },
    );

    return unsubscribe;
  }, [navigate]);

  // Declared *after* the subscription on purpose: React destroys layout effects
  // in creation order, so the unsubscribe above runs first and this final clear
  // cannot fire the subscriber — which would otherwise push a stray
  // `?agent=…` entry while the user is already navigating away.
  useLayoutEffect(
    () => () => {
      useChatStore.setState(
        { activeTopicId: undefined },
        false,
        'HomeConversationHydration/clearTopicId',
      );
    },
    [],
  );

  return null;
});

Hydration.displayName = 'HomeConversationHydrationInner';

/**
 * Mounted only while the home shell actually owns a conversation. Rendering
 * `null` off-home (or once the params are gone) is what makes the cleanups run
 * inside the navigation commit instead of ~`HOME_FADE_MS` later, when
 * `<Activity mode="hidden">` finally destroys the home subtree's effects.
 */
const HomeConversationHydration = memo(() => {
  const conversation = useActiveHomeConversation();

  if (!conversation) return null;

  return <Hydration {...conversation} />;
});

HomeConversationHydration.displayName = 'HomeConversationHydration';

export default HomeConversationHydration;
