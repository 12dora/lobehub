'use client';

import { INBOX_SESSION_ID } from '@lobechat/const';
import { memo } from 'react';

import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import { useAgentStore } from '@/store/agent';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/selectors';

/** Keeps the builtin inbox projection aligned with the effective Published branding revision. */
const DefaultInboxBrandingSync = memo(() => {
  const brandingRevision = useBranding().publishedRevision;
  const isLogin = useUserStore(authSelectors.isLogin);
  const useInitBuiltinAgent = useAgentStore((s) => s.useInitBuiltinAgent);

  useInitBuiltinAgent(INBOX_SESSION_ID, {
    brandingRevision,
    isLogin: Boolean(isLogin),
  });

  return null;
});

DefaultInboxBrandingSync.displayName = 'DefaultInboxBrandingSync';

export default DefaultInboxBrandingSync;
