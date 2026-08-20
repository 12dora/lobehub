import { ActionIcon, DropdownMenu, Flexbox, Icon } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { FileTextIcon, HashIcon, MoreHorizontalIcon } from 'lucide-react';
import { memo, useCallback, useState } from 'react';

import InlineRename from '@/components/InlineRename';
import TaskStatusIcon from '@/features/AgentTasks/features/TaskStatusIcon';
import NavItem from '@/features/NavPanel/components/NavItem';
import { usePrefetchAgent } from '@/hooks/usePrefetchAgent';
import { usePrefetchPage } from '@/hooks/usePrefetchPage';
import { getPlatformIcon } from '@/routes/(main)/agent/channel/const';
import { type RecentItem } from '@/server/routers/lambda/recent';

import { useRecentItemDropdownMenu } from './useDropdownMenu';

const TYPE_ICON_MAP: Partial<Record<'document' | 'task' | 'topic', typeof FileTextIcon>> = {
  document: FileTextIcon,
  topic: HashIcon,
};

interface RecentListItemProps extends RecentItem {
  /**
   * Selected state, driven by the conversation open in the home right column.
   * `NavItem` renders it as a filled `Block` — the exact same highlight the
   * agent chat sidebar's topic rows use.
   */
  active?: boolean;
}

const RecentListItem = memo<RecentListItemProps>(({ active, ...item }) => {
  const { title, type, agentId, id, metadata, status } = item;
  const IconComponent = TYPE_ICON_MAP[type] || FileTextIcon;
  const [editing, setEditing] = useState(false);
  const prefetchAgent = usePrefetchAgent();
  const prefetchPage = usePrefetchPage();

  const toggleEditing = useCallback((visible?: boolean) => {
    setEditing(!!visible);
  }, []);

  const handleMouseEnter = useCallback(() => {
    switch (type) {
      case 'topic':
      case 'task': {
        if (agentId) prefetchAgent(agentId);
        break;
      }
      case 'document': {
        prefetchPage(id);
        break;
      }
    }
  }, [type, agentId, id, prefetchAgent, prefetchPage]);

  const { dropdownMenu, handleRename } = useRecentItemDropdownMenu(item, toggleEditing);

  return (
    <Flexbox style={{ position: 'relative' }}>
      <NavItem
        active={active}
        contextMenuItems={dropdownMenu}
        disabled={editing}
        title={title}
        // Match the agent sidebar's topic rows: conversation titles stay fully
        // emphasized even when the row is not selected.
        titleColor={cssVar.colorText}
        actions={
          <DropdownMenu items={dropdownMenu()} nativeButton={false}>
            <ActionIcon icon={MoreHorizontalIcon} size={'small'} style={{ flex: 'none' }} />
          </DropdownMenu>
        }
        icon={(() => {
          if (type === 'task') {
            return <TaskStatusIcon size={16} status={status ?? 'backlog'} />;
          }

          if (type === 'topic' && metadata?.bot?.platform) {
            const ProviderIcon = getPlatformIcon(metadata.bot.platform);
            if (ProviderIcon) {
              return <ProviderIcon color={cssVar.colorTextDescription} size={16} />;
            }
          }
          return (
            <Icon
              icon={IconComponent}
              size={'small'}
              style={{ color: cssVar.colorTextDescription }}
            />
          );
        })()}
        onMouseEnter={handleMouseEnter}
      />
      <InlineRename
        open={editing}
        title={title}
        onOpenChange={(open) => toggleEditing(open)}
        onSave={handleRename}
      />
    </Flexbox>
  );
});

export default RecentListItem;
