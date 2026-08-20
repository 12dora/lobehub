'use client';

import { Flexbox } from '@lobehub/ui';
import { memo, Suspense, useMemo } from 'react';

import ChatMiniMap from '@/features/ChatMiniMap';
import { ChatList, ConversationProvider } from '@/features/Conversation';
import {
  ForwardMessageDispatcher,
  MessageForwardFooter,
} from '@/features/Conversation/MessageForward';
import { useOperationState } from '@/hooks/useOperationState';
import { useChatStore } from '@/store/chat';
import { messageMapKey } from '@/store/chat/utils/messageMapKey';

import WelcomeChatItem from './AgentWelcome';
import ChatHydration from './ChatHydration';
import MainChatInput from './MainChatInput';
import MessageFromUrl from './MainChatInput/MessageFromUrl';
import ThreadHydration from './ThreadHydration';
import { useActionsBarConfig } from './useActionsBarConfig';
import { useGroupContext } from './useGroupContext';

interface ConversationAreaProps {
  /**
   * Skip the group route's `ChatHydration`.
   *
   * That hydrator reads `:gid` / `:topicId` off the **path**, so a host that
   * addresses the conversation some other way (the home shell's
   * `/?group=…&topic=…`) must opt out: with no path params it would reset
   * `activeTopicId` to null and blank the conversation the host just selected.
   * Defaults to `false` — the group route keeps hydrating from its own params.
   */
  disableRouteHydration?: boolean;
  mobile?: boolean;
}

/**
 * ConversationArea
 *
 * Main conversation area component using the new ConversationStore architecture.
 * Uses ChatList from @/features/Conversation and MainChatInput for custom features.
 */
const Conversation = memo<ConversationAreaProps>(
  ({ disableRouteHydration = false, mobile = false }) => {
    const context = useGroupContext();

    // Get raw dbMessages from ChatStore for this context
    // ConversationStore will parse them internally to generate displayMessages
    const chatKey = useMemo(
      () => messageMapKey(context),
      [context.agentId, context.topicId, context.threadId],
    );
    const replaceMessages = useChatStore((s) => s.replaceMessages);
    const messages = useChatStore((s) => s.dbMessagesMap[chatKey]);

    // Get operation state from ChatStore for reactive updates
    const operationState = useOperationState(context);

    const actionsBarConfig = useActionsBarConfig();

    return (
      <ConversationProvider
        actionsBar={actionsBarConfig}
        context={context}
        hasInitMessages={!!messages}
        messages={messages}
        operationState={operationState}
        onMessagesChange={(messages, ctx) => {
          replaceMessages(messages, { context: ctx });
        }}
      >
        <Flexbox
          flex={1}
          width={'100%'}
          style={{
            overflowX: 'hidden',
            overflowY: 'auto',
            position: 'relative',
          }}
        >
          <ChatList welcome={<WelcomeChatItem />} />
        </Flexbox>
        <MessageForwardFooter>
          <MainChatInput />
        </MessageForwardFooter>
        {!disableRouteHydration && <ChatHydration />}
        <ThreadHydration />
        <ForwardMessageDispatcher />
        {!mobile && (
          <>
            <ChatMiniMap />
            <Suspense>
              <MessageFromUrl />
            </Suspense>
          </>
        )}
      </ConversationProvider>
    );
  },
);

Conversation.displayName = 'ConversationArea';

export default Conversation;
