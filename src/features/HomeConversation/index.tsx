'use client';

import { memo } from 'react';

import Loading from '@/components/Loading/BrandTextLoading';
import DelayedFallback from '@/components/Loading/DelayedFallback';
import dynamic from '@/libs/next/dynamic';

import HomeConversationHydration from './HomeConversationHydration';
import { type HomeConversationParams } from './useHomeConversation';

// The home shell is part of the boot chunk; the chat surfaces are not. Keep
// them lazy so opening the app on `/` does not pull the whole conversation
// tree.
const AgentSurface = dynamic(() => import('./AgentSurface'), {
  loading: () => (
    <DelayedFallback>
      <Loading debugId="HomeConversation > Agent" variant={'inline'} />
    </DelayedFallback>
  ),
});
const GroupSurface = dynamic(() => import('./GroupSurface'), {
  loading: () => (
    <DelayedFallback>
      <Loading debugId="HomeConversation > Group" variant={'inline'} />
    </DelayedFallback>
  ),
});

/**
 * Right column of the home overlay when a recent conversation is open.
 *
 * The pathname stays home (`/` or `/:workspaceSlug`), so `NavPanel` keeps the
 * home portal, `RouteTransition` keeps the `home` key and the overlay stays
 * visible — only this column swaps from the home landing to the conversation.
 */
const HomeConversation = memo<HomeConversationParams>(({ agentId, groupId }) => (
  <>
    <HomeConversationHydration />
    {groupId ? <GroupSurface /> : agentId ? <AgentSurface agentId={agentId} /> : null}
  </>
));

HomeConversation.displayName = 'HomeConversation';

export default HomeConversation;
export { default as HomeConversationHydration } from './HomeConversationHydration';
export {
  HOME_CONVERSATION_AGENT_PARAM,
  HOME_CONVERSATION_GROUP_PARAM,
  HOME_CONVERSATION_TOPIC_PARAM,
  homeConversationUrl,
  homeConversationUrlFromChatPath,
} from './homeConversationPath';
export {
  type HomeConversationParams,
  useActiveHomeConversation,
  useHomeConversationParams,
  useIsHomeRoute,
} from './useHomeConversation';
