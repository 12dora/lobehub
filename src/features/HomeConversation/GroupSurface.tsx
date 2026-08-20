'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import { useInitGroupConfig } from '@/hooks/useInitGroupConfig';
import Conversation from '@/routes/(main)/group/features/Conversation';
import Portal from '@/routes/(main)/group/features/Portal';

/**
 * The group chat surface, re-hosted inside the home right column.
 *
 * Mirrors `group/index.tsx` minus its `ChatHydration` (pathname rewrite) and
 * minus the group `_layout` chrome (sidebar, hotkeys, `GroupIdSync`). The group
 * store's `activeGroupId` / `router` are owned by `HomeConversationHydration`.
 */
const GroupSurface = memo(() => {
  useInitGroupConfig();

  return (
    <Flexbox
      horizontal
      flex={1}
      height={'100%'}
      style={{ minHeight: 0, overflow: 'hidden', position: 'relative' }}
      width={'100%'}
    >
      <Conversation />
      <Portal />
    </Flexbox>
  );
});

GroupSurface.displayName = 'HomeGroupSurface';

export default GroupSurface;
