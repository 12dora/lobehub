'use client';

import { ActionIcon, Avatar, Block, Text } from '@lobehub/ui';
import { ChevronsUpDownIcon } from 'lucide-react';
import { type PropsWithChildren } from 'react';
import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { DESKTOP_HEADER_ICON_SMALL_SIZE } from '@/const/layoutTokens';
import { DEFAULT_AVATAR } from '@/const/meta';
import { type SidebarAgentItem } from '@/database/repositories/home';
import { SkeletonItem } from '@/features/NavPanel/components/SkeletonList';
import { useDefaultInboxAvatar } from '@/hooks/useDefaultInboxAvatar';
import { useDefaultInboxDisplayName } from '@/hooks/useDefaultInboxDisplayName';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors, builtinAgentSelectors } from '@/store/agent/selectors';
import { useHomeStore } from '@/store/home';
import { type HomeStoreState } from '@/store/home/initialState';

import SwitchPanel from './SwitchPanel';
import { useRoutedAgentId } from './useRoutedAgentId';

/**
 * Cheap identity fallback: the sidebar list the user just clicked already
 * carries title/avatar for this agent, so the chip can paint real data before
 * (or instead of) the agent config fetch resolves. Returns the item object
 * straight out of the store so the selector keeps a stable reference.
 */
export const findSidebarAgentItem = (
  s: HomeStoreState,
  agentId?: string,
): SidebarAgentItem | undefined => {
  if (!agentId) return undefined;

  for (const bucket of [s.pinnedAgents, s.ungroupedAgents, s.privateUngroupedAgents]) {
    const hit = bucket.find((item) => item.id === agentId);
    if (hit) return hit;
  }

  for (const group of [...s.agentGroups, ...s.privateAgentGroups]) {
    const hit = group.items?.find((item) => item.id === agentId);
    if (hit) return hit;
  }

  return undefined;
};

const Agent = memo<PropsWithChildren>(() => {
  const { t } = useTranslation(['chat', 'common']);

  // Identity follows the URL, not `activeAgentId`: the store value is written
  // by route-level syncs and can be cleared/overwritten by another tree after
  // this chip has painted (e.g. the home layout's delayed <Activity> teardown).
  // Falling back to `activeAgentId` only covers the anonymous / non-agent-route
  // mounts where the pathname carries no id.
  const routedAgentId = useRoutedAgentId();
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const agentId = routedAgentId || activeAgentId;

  const [agentData, inboxAgentId, configError] = useAgentStore((s) => [
    agentId ? s.agentMap[agentId] : undefined,
    builtinAgentSelectors.inboxAgentId(s),
    agentByIdSelectors.getAgentConfigErrorById(agentId || '')(s),
  ]);

  const listMeta = useHomeStore((s) => findSidebarAgentItem(s, agentId));

  const isInbox = !!agentId && agentId === inboxAgentId;

  const title = agentData?.title ?? listMeta?.title ?? undefined;
  const avatar =
    agentData?.avatar ?? (typeof listMeta?.avatar === 'string' ? listMeta.avatar : undefined);
  const backgroundColor = agentData?.backgroundColor ?? listMeta?.backgroundColor ?? undefined;

  const inboxDisplayName = useDefaultInboxDisplayName(title);
  const inboxAvatar = useDefaultInboxAvatar(avatar);
  const displayTitle = isInbox ? inboxDisplayName : title || t('defaultSession', { ns: 'common' });
  const displayAvatar = isInbox ? inboxAvatar : avatar || DEFAULT_AVATAR;

  // Skeleton only while the identity is genuinely unknown. A config fetch error
  // or a known inbox/list identity must render the real chip — otherwise the
  // skeleton never resolves (the previous predicate spun forever whenever
  // `activeAgentId` was cleared after paint).
  const isIdentityUnknown = !agentData && !listMeta && !configError && !isInbox;

  if (isIdentityUnknown) return <SkeletonItem height={32} padding={0} />;

  return (
    <SwitchPanel>
      <Block
        clickable
        horizontal
        align={'center'}
        gap={8}
        padding={2}
        variant={'borderless'}
        style={{
          minWidth: 32,
          overflow: 'hidden',
        }}
      >
        <Avatar
          avatar={displayAvatar}
          background={backgroundColor || undefined}
          shape={'square'}
          size={28}
        />
        <Text ellipsis weight={500}>
          {displayTitle}
        </Text>
        <ActionIcon
          icon={ChevronsUpDownIcon}
          size={DESKTOP_HEADER_ICON_SMALL_SIZE}
          style={{
            width: 24,
          }}
        />
      </Block>
    </SwitchPanel>
  );
});

export default Agent;
