'use client';

import { Avatar, Block } from '@lobehub/ui';
import { memo } from 'react';

import { useDefaultInboxAvatar } from '@/hooks/useDefaultInboxAvatar';
import { useOpenChatSettings } from '@/hooks/useInterceptingRoutes';
import { useAgentStore } from '@/store/agent';
import { agentSelectors, builtinAgentSelectors } from '@/store/agent/selectors';

const HeaderAvatar = memo(() => {
  const [avatar, backgroundColor, isInbox] = useAgentStore((s) => [
    agentSelectors.currentAgentAvatar(s),
    agentSelectors.currentAgentBackgroundColor(s),
    !!s.activeAgentId && builtinAgentSelectors.inboxAgentId(s) === s.activeAgentId,
  ]);
  const inboxAvatar = useDefaultInboxAvatar(avatar);

  const openChatSettings = useOpenChatSettings();

  return (
    <Block
      clickable
      flex={'none'}
      height={32}
      padding={2}
      variant={'borderless'}
      width={32}
      style={{
        overflow: 'hidden',
      }}
      onClick={(e) => {
        e.stopPropagation();
        openChatSettings();
      }}
    >
      <Avatar avatar={isInbox ? inboxAvatar : avatar} background={backgroundColor} size={28} />
    </Block>
  );
});

export default HeaderAvatar;
