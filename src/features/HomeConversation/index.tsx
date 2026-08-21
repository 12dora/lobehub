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
//
// The loaders are named so the prefetch helpers below can reuse the *identical*
// module specifier — Vite/webpack dedupe on the specifier, so a warmed chunk is
// resolved synchronously by `dynamic` instead of blanking the right column
// behind `DelayedFallback` (which renders nothing for its first 200ms).
const importAgentSurface = () => import('./AgentSurface');
const importGroupSurface = () => import('./GroupSurface');

const AgentSurface = dynamic(importAgentSurface, {
  loading: () => (
    <DelayedFallback>
      <Loading debugId="HomeConversation > Agent" variant={'inline'} />
    </DelayedFallback>
  ),
});
const GroupSurface = dynamic(importGroupSurface, {
  loading: () => (
    <DelayedFallback>
      <Loading debugId="HomeConversation > Group" variant={'inline'} />
    </DelayedFallback>
  ),
});

/**
 * Warm the agent conversation chunk. Idempotent — the module registry caches
 * the promise, so calling it on every composer focus costs nothing after the
 * first. Failures are swallowed: this is a pure optimisation, the real mount
 * still goes through `dynamic`'s own loading/error handling.
 */
export const prefetchAgentSurface = (): void => {
  void importAgentSurface().catch(() => {});
};

/** Warm the group conversation chunk. See `prefetchAgentSurface`. */
export const prefetchGroupSurface = (): void => {
  void importGroupSurface().catch(() => {});
};

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
