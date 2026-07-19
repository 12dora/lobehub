import { DEFAULT_INBOX_TITLE } from '@lobechat/const';

import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import { useCacheScope } from '@/libs/swr/useCacheScope';
import { useAgentStore } from '@/store/agent';
import { builtinAgentSelectors } from '@/store/agent/selectors';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/selectors';
import type { RuntimeBranding } from '@/types/platform/branding';

export const resolveDefaultInboxDisplayName = (
  configuredTitle: string | null | undefined,
  branding: Pick<RuntimeBranding, 'defaultAgentDisplayName'>,
): string => {
  if (configuredTitle?.trim()) return configuredTitle;

  return branding.defaultAgentDisplayName?.trim() || DEFAULT_INBOX_TITLE;
};

/** User-visible fallback only; the stable inbox id and slug never depend on branding. */
export const useDefaultInboxDisplayName = (configuredTitle?: string | null): string => {
  const branding = useBranding();
  return resolveDefaultInboxDisplayName(configuredTitle, branding);
};

/** Display name from the Inbox projection owned by the current resolved login scope. */
export const useScopedDefaultInboxDisplayName = (): string => {
  const cacheScope = useCacheScope();
  const isLogin = useUserStore(authSelectors.isLogin);
  const inboxMeta = useAgentStore(
    builtinAgentSelectors.inboxAgentMetaForScope(isLogin === true ? cacheScope : undefined),
  );

  return useDefaultInboxDisplayName(inboxMeta?.title);
};
