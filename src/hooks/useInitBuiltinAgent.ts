import { type BuiltinAgentSlug } from '@lobechat/builtin-agents';

import { useCacheScope } from '@/libs/swr/useCacheScope';
import { useAgentStore } from '@/store/agent';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/selectors';

/**
 * If a targetAgentId is provided, use it to fetch the agent config directly.
 * Otherwise, use the active session id to fetch the config.
 */
export const useInitBuiltinAgent = (slug: BuiltinAgentSlug) => {
  const useInitBuiltinAgent = useAgentStore((s) => s.useInitBuiltinAgent);

  const cacheScope = useCacheScope();
  const isLogin = useUserStore(authSelectors.isLogin);

  useInitBuiltinAgent(slug, { cacheScope, isLogin });
};
