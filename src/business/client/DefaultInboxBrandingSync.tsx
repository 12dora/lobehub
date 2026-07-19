'use client';

import { INBOX_SESSION_ID } from '@lobechat/const';
import { memo, useLayoutEffect } from 'react';

import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import { useCacheScope } from '@/libs/swr/useCacheScope';
import { useAgentStore } from '@/store/agent';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/selectors';

/** Keeps the builtin inbox projection aligned with the effective Published branding revision. */
const DefaultInboxBrandingSync = memo(() => {
  const brandingRevision = useBranding().publishedRevision;
  const cacheScope = useCacheScope();
  const isLogin = useUserStore(authSelectors.isLogin);
  const syncInboxProjectionScope = useAgentStore((s) => s.syncInboxProjectionScope);
  const useInitBuiltinAgent = useAgentStore((s) => s.useInitBuiltinAgent);

  useLayoutEffect(() => {
    syncInboxProjectionScope(cacheScope, isLogin === true);
  }, [cacheScope, isLogin, syncInboxProjectionScope]);

  useInitBuiltinAgent(INBOX_SESSION_ID, {
    brandingRevision,
    cacheScope,
    isLogin: Boolean(isLogin),
  });

  return null;
});

DefaultInboxBrandingSync.displayName = 'DefaultInboxBrandingSync';

export default DefaultInboxBrandingSync;
