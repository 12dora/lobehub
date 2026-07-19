'use client';

import { INBOX_SESSION_ID } from '@lobechat/const';
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router';

import Loading from '@/components/Loading/BrandTextLoading';
import { WelcomeExtraProvider } from '@/features/AgentHome/WelcomeExtraContext';
import { useCurrentInboxAgentId } from '@/hooks/useCurrentInboxAgent';
import { useFetchTopics } from '@/hooks/useFetchTopics';
import { useInitAgentConfig } from '@/hooks/useInitAgentConfig';
import Conversation from '@/routes/(main)/agent/features/Conversation';
import { useAgentStore } from '@/store/agent';
import { useChatStore } from '@/store/chat';

import QuickChatAgentSwitcher from './QuickChatAgentSwitcher';

const PopupAgentQuickPage = memo(() => {
  const { aid } = useParams<{ aid: string }>();
  const inboxAgentId = useCurrentInboxAgentId();
  const previousInboxAgentIdRef = useRef<string | undefined>(undefined);

  // The inbox slug is not a real agent id. Resolve it through
  // `builtinAgentIdMap` so `activeAgentId` points at the actual entity in
  // `agentMap` and `isAgentConfigLoading` can flip to false.
  const isInboxSlug = aid === INBOX_SESSION_ID;
  const effectiveAgentId = isInboxSlug ? inboxAgentId : aid;

  // For non-inbox agents fetch the config explicitly. The inbox config is
  // seeded by `useInitBuiltinAgent('inbox')` in StoreInitialization.
  useInitAgentConfig(isInboxSlug ? undefined : aid);

  useLayoutEffect(() => {
    const previousInboxAgentId = previousInboxAgentIdRef.current;

    if (!effectiveAgentId) {
      if (!isInboxSlug || !previousInboxAgentId) return;

      if (useAgentStore.getState().activeAgentId === previousInboxAgentId)
        useAgentStore.setState(
          { activeAgentId: undefined },
          false,
          'PopupAgentQuickPage/clearStaleInbox',
        );
      if (useChatStore.getState().activeAgentId === previousInboxAgentId)
        useChatStore.setState(
          { activeAgentId: undefined },
          false,
          'PopupAgentQuickPage/clearStaleInbox',
        );
      return;
    }

    useAgentStore.setState({ activeAgentId: effectiveAgentId }, false, 'PopupAgentQuickPage/sync');
    useChatStore.setState(
      {
        activeAgentId: effectiveAgentId,
        activeGroupId: undefined,
        activeThreadId: undefined,
        activeTopicId: undefined,
      },
      false,
      'PopupAgentQuickPage/sync',
    );

    if (isInboxSlug) previousInboxAgentIdRef.current = effectiveAgentId;
  }, [effectiveAgentId, isInboxSlug]);

  useFetchTopics({
    enabled: Boolean(effectiveAgentId),
    session: { agentId: effectiveAgentId, isInbox: isInboxSlug },
  });

  const welcomeExtra = useMemo(() => ({ extra: <QuickChatAgentSwitcher /> }), []);

  if (!effectiveAgentId) return <Loading debugId="PopupAgentQuickPage" />;

  return (
    <WelcomeExtraProvider value={welcomeExtra}>
      <Conversation />
    </WelcomeExtraProvider>
  );
});

PopupAgentQuickPage.displayName = 'PopupAgentQuickPage';

export default PopupAgentQuickPage;
