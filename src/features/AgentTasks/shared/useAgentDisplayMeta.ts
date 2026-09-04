import { DEFAULT_AVATAR } from '@lobechat/const';
import { cssVar } from 'antd-style';
import { useTranslation } from 'react-i18next';

import { useDefaultInboxAvatar } from '@/hooks/useDefaultInboxAvatar';
import { useDefaultInboxDisplayName } from '@/hooks/useDefaultInboxDisplayName';
import { useAgentStore } from '@/store/agent';
import { agentSelectors, builtinAgentSelectors } from '@/store/agent/selectors';
import { useHomeStore } from '@/store/home';
import { homeAgentListSelectors } from '@/store/home/selectors';

import { isInboxAgentId } from './isInboxAgent';

interface AgentDisplayMeta {
  avatar: string;
  backgroundColor: string;
  title: string;
}

interface UseAgentDisplayMetaOptions {
  fallbackToDefault?: boolean;
}

/**
 * Resolves agent display metadata from agent store with sidebar data as fallback.
 * The agent store only contains agents the user has actively visited, so sidebar
 * data (loaded eagerly) fills the gap for agents not yet in the store.
 */
export const useAgentDisplayMeta = (
  agentId: string | null | undefined,
  { fallbackToDefault = true }: UseAgentDisplayMetaOptions = {},
): AgentDisplayMeta | undefined => {
  const { t } = useTranslation(['chat', 'common']);
  const inboxAgentId = useAgentStore(builtinAgentSelectors.inboxAgentId);
  const meta = useAgentStore((s) =>
    agentId ? agentSelectors.getAgentMetaById(agentId)(s) : undefined,
  );
  const sidebarAgent = useHomeStore(homeAgentListSelectors.getAgentById(agentId ?? ''));
  const sidebarAvatar = typeof sidebarAgent?.avatar === 'string' ? sidebarAgent.avatar : undefined;
  const inboxAvatar = useDefaultInboxAvatar(meta?.avatar || sidebarAvatar);
  const inboxTitle = useDefaultInboxDisplayName(meta?.title || sidebarAgent?.title);

  if (!agentId) return undefined;

  const isInbox = isInboxAgentId(agentId, inboxAgentId);
  const hasResolvedMeta =
    isInbox || !!meta?.avatar || !!meta?.backgroundColor || !!meta?.title?.trim() || !!sidebarAgent;

  if (!fallbackToDefault && !hasResolvedMeta) return undefined;

  return {
    avatar: isInbox ? inboxAvatar : meta?.avatar || sidebarAvatar || DEFAULT_AVATAR,
    backgroundColor:
      meta?.backgroundColor || sidebarAgent?.backgroundColor || cssVar.colorBgContainer,
    title: isInbox
      ? inboxTitle
      : meta?.title?.trim() || sidebarAgent?.title || t('defaultSession', { ns: 'common' }),
  };
};
