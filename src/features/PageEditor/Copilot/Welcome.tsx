'use client';

import { Avatar, Flexbox, Markdown, Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { conversationSelectors, useConversationStore } from '@/features/Conversation';
import SuggestQuestions from '@/features/SuggestQuestions';
import { useDefaultInboxAvatar } from '@/hooks/useDefaultInboxAvatar';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';

const AgentBuilderWelcome = memo(() => {
  const { t } = useTranslation('chat');
  const agentId = useConversationStore(conversationSelectors.agentId);
  const agent = useAgentStore(agentByIdSelectors.getAgentConfigById(agentId));
  const avatar = useDefaultInboxAvatar(agent?.avatar);

  return (
    <>
      <Flexbox flex={1} />
      <Flexbox
        gap={12}
        width={'100%'}
        style={{
          paddingBottom: 16,
        }}
      >
        <Avatar avatar={avatar} shape={'square'} size={78} />
        <Text fontSize={24} weight={'bold'}>
          {t('pageCopilot.title')}
        </Text>
        <Markdown fontSize={14} variant={'chat'}>
          {t('pageCopilot.welcome')}
        </Markdown>
        <SuggestQuestions count={3} mode="write" />
      </Flexbox>
    </>
  );
});

export default AgentBuilderWelcome;
