import { useCacheScope } from '@/libs/swr/useCacheScope';
import { useAgentStore } from '@/store/agent';
import { builtinAgentSelectors } from '@/store/agent/selectors';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/selectors';

const useCurrentInboxScope = (): string | undefined => {
  const cacheScope = useCacheScope();
  const isLogin = useUserStore(authSelectors.isLogin);

  return isLogin === true ? cacheScope : undefined;
};

/** Inbox id projected for the currently resolved authenticated identity/workspace. */
export const useCurrentInboxAgentId = (): string | undefined => {
  const scope = useCurrentInboxScope();

  return useAgentStore(builtinAgentSelectors.inboxAgentIdForScope(scope));
};

/** Inbox metadata projected for the currently resolved authenticated identity/workspace. */
export const useCurrentInboxAgentMeta = () => {
  const scope = useCurrentInboxScope();

  return useAgentStore(builtinAgentSelectors.inboxAgentMetaForScope(scope));
};
