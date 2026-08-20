'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import DragUploadZone, { useUploadFiles } from '@/components/DragUploadZone';
import { useFetchChatTopics } from '@/hooks/useFetchChatTopics';
import { useInitGroupConfig } from '@/hooks/useInitGroupConfig';
import ConversationArea from '@/routes/(main)/group/features/Conversation/ConversationArea';
import ChatHeader from '@/routes/(main)/group/features/Conversation/Header';
import Portal from '@/routes/(main)/group/features/Portal';
import { useAgentStore } from '@/store/agent';
import { agentSelectors } from '@/store/agent/selectors';

/**
 * The group chat surface, re-hosted inside the home right column.
 *
 * Mirrors `group/index.tsx` + `group/features/Conversation/index.tsx` minus two
 * things that belong to the group *route*:
 *
 * - the group `_layout` chrome (sidebar, hotkeys, `GroupIdSync`) — `activeGroupId`
 *   and the navigation adapter are owned by `HomeConversationHydration`;
 * - `ConversationArea`'s own `ChatHydration`, which reads `:gid` / `:topicId`
 *   from the path. On `/` it would find neither and reset `activeTopicId` to
 *   null, blanking the conversation the user just opened.
 *
 * It also has to fetch the topic list itself: the group sidebar (the only other
 * `useFetchChatTopics` caller) never mounts here, so without this the selected
 * topic is missing from `topicDataMap` and the header, rename/delete actions and
 * topic-bound metadata all fall back to "new topic" defaults.
 */
const GroupSurface = memo(() => {
  useInitGroupConfig();
  useFetchChatTopics();

  const agentId = useAgentStore((s) => s.activeAgentId || '');
  const model = useAgentStore(agentSelectors.currentAgentModel);
  const provider = useAgentStore(agentSelectors.currentAgentModelProvider);
  const { handleUploadFiles } = useUploadFiles({ agentId, model, provider });

  return (
    <Flexbox
      horizontal
      flex={1}
      height={'100%'}
      style={{ minHeight: 0, overflow: 'hidden', position: 'relative' }}
      width={'100%'}
    >
      <DragUploadZone style={{ height: '100%', width: '100%' }} onUploadFiles={handleUploadFiles}>
        <Flexbox
          height={'100%'}
          style={{ overflow: 'hidden', position: 'relative' }}
          width={'100%'}
        >
          <ChatHeader />
          <ConversationArea disableRouteHydration />
        </Flexbox>
      </DragUploadZone>
      <Portal />
    </Flexbox>
  );
});

GroupSurface.displayName = 'HomeGroupSurface';

export default GroupSurface;
