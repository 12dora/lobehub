'use client';

import { Empty, Flexbox, SearchBar } from '@lobehub/ui';
import { SearchIcon } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useActiveHomeConversation } from '@/features/HomeConversation/useHomeConversation';
import SkeletonList from '@/features/NavPanel/components/SkeletonList';
import SideBarDrawer from '@/features/NavPanel/SideBarDrawer';
import WorkspaceLink from '@/features/Workspace/WorkspaceLink';
import { useClientDataSWR } from '@/libs/swr';
import { recentKeys } from '@/libs/swr/keys';
import { useCacheScope } from '@/libs/swr/useCacheScope';
import { recentService } from '@/services/recent';

import RecentListItem from './Item';
import { getRecentRoute } from './recentRoute';

interface AllRecentsDrawerProps {
  onClose: () => void;
  open: boolean;
}

const AllRecentsDrawer = memo<AllRecentsDrawerProps>(({ open, onClose }) => {
  const { t } = useTranslation('common');
  const [searchKeyword, setSearchKeyword] = useState('');
  const scope = useCacheScope();

  const { data: recents, isLoading } = useClientDataSWR(
    open ? recentKeys.allDrawer(open, scope) : null,
    () => recentService.getAll(50),
  );

  const filteredRecents = useMemo(() => {
    if (!recents) return [];
    const keyword = searchKeyword.trim().toLowerCase();
    if (!keyword) return recents;
    return recents.filter((item) => item.title.toLowerCase().includes(keyword));
  }, [recents, searchKeyword]);

  const activeTopicId = useActiveHomeConversation()?.topicId;

  return (
    <SideBarDrawer
      open={open}
      title={t('recents')}
      subHeader={
        <Flexbox paddingBlock={'0 8px'} paddingInline={8}>
          <SearchBar
            allowClear
            defaultValue={searchKeyword}
            placeholder={t('navPanel.searchRecent')}
            onSearch={(keyword) => setSearchKeyword(keyword)}
            onInputChange={(keyword) => {
              setSearchKeyword(keyword);
            }}
          />
        </Flexbox>
      }
      onClose={onClose}
    >
      <Flexbox gap={1} paddingBlock={1} paddingInline={4}>
        {isLoading || !recents ? (
          <SkeletonList rows={5} />
        ) : filteredRecents.length === 0 && searchKeyword.trim() ? (
          <Empty
            description={t('navPanel.searchResultEmpty')}
            icon={SearchIcon}
            style={{ paddingBlock: 24 }}
          />
        ) : (
          filteredRecents.map((item) => (
            <WorkspaceLink
              key={`${item.type}-${item.id}`}
              style={{ color: 'inherit', textDecoration: 'none' }}
              to={getRecentRoute(item)}
            >
              <RecentListItem
                {...item}
                active={item.type === 'topic' && item.id === activeTopicId}
              />
            </WorkspaceLink>
          ))
        )}
      </Flexbox>
    </SideBarDrawer>
  );
});

AllRecentsDrawer.displayName = 'AllRecentsDrawer';

export default AllRecentsDrawer;
