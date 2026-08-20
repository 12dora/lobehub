import { useMemo } from 'react';
import { useLocation, useSearchParams } from 'react-router';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';

import {
  HOME_CONVERSATION_AGENT_PARAM,
  HOME_CONVERSATION_GROUP_PARAM,
  HOME_CONVERSATION_TOPIC_PARAM,
} from './homeConversationPath';

export interface HomeConversationParams {
  agentId?: string;
  groupId?: string;
  topicId?: string;
}

/**
 * Same predicate as `home/_layout/Sidebar` and `NavPanel`: the home shell owns
 * the route while the pathname is the workspace root, regardless of search
 * params. Kept here so the conversation feature and `HomeAgentIdSync` cannot
 * drift from it.
 */
export const useIsHomeRoute = (): boolean => {
  const { pathname } = useLocation();
  const activeSlug = useActiveWorkspaceSlug();

  return (
    pathname === '/' ||
    (!!activeSlug && (pathname === `/${activeSlug}` || pathname === `/${activeSlug}/`))
  );
};

/**
 * Conversation addressed by the current search params, ignoring the pathname.
 * `topic` is optional: starting a new topic from inside the home conversation
 * drops it while keeping the surface open.
 */
export const useHomeConversationParams = (): HomeConversationParams | null => {
  const [searchParams] = useSearchParams();

  const agentId = searchParams.get(HOME_CONVERSATION_AGENT_PARAM);
  const groupId = searchParams.get(HOME_CONVERSATION_GROUP_PARAM);
  const topicId = searchParams.get(HOME_CONVERSATION_TOPIC_PARAM);

  return useMemo(() => {
    if (groupId) return { groupId, topicId: topicId || undefined };
    if (agentId) return { agentId, topicId: topicId || undefined };
    return null;
  }, [agentId, groupId, topicId]);
};

/**
 * The conversation the home right column should render — only while home still
 * owns the pathname. Off-home this returns `null` in the navigation commit, so
 * the hydrator unmounts (and cleans the stores) before the agent/group route's
 * own `*IdSync` layout effects run.
 */
export const useActiveHomeConversation = (): HomeConversationParams | null => {
  const isHomeRoute = useIsHomeRoute();
  const conversation = useHomeConversationParams();

  return isHomeRoute ? conversation : null;
};
