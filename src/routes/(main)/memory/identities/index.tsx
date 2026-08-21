import { Flexbox, Icon, Tag } from '@lobehub/ui';
import { BrainCircuitIcon } from 'lucide-react';
import { type FC } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';

import DelayedFallback from '@/components/Loading/DelayedFallback';
import NavHeader from '@/features/NavHeader';
import WideScreenContainer from '@/features/WideScreenContainer';
import WideScreenButton from '@/features/WideScreenContainer/WideScreenButton';
import { useQueryState } from '@/hooks/useQueryParam';
import ActionBar from '@/routes/(main)/memory/features/ActionBar';
import CommonFilterBar from '@/routes/(main)/memory/features/FilterBar';
import { useUserMemoryStore } from '@/store/userMemory';
import { type TypesEnum } from '@/types/userMemory';

import EditableModal from '../features/EditableModal';
import Loading from '../features/Loading';
import { SCROLL_PARENT_ID } from '../features/TimeLineView/useScrollParent';
import { type ViewMode } from '../features/ViewModeSwitcher';
import ViewModeSwitcher from '../features/ViewModeSwitcher';
import IdentityRightPanel from './features/IdentityRightPanel';
import { type IdentityType } from './features/List';
import List from './features/List';
import SegmentedBar from './features/SegmentedBar';

const IdentitiesArea = memo(() => {
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [searchValueRaw, setSearchValueRaw] = useQueryState('q', { clearOnDefault: true });
  const [typeFilterRaw, setTypeFilterRaw] = useQueryState('type', { clearOnDefault: true });

  const searchValue = searchValueRaw || '';
  const typeFilter = (typeFilterRaw as IdentityType) || 'all';

  const identitiesCount = useUserMemoryStore((s) => s.identities.length);
  const identitiesPage = useUserMemoryStore((s) => s.identitiesPage);
  const identitiesInit = useUserMemoryStore((s) => s.identitiesInit);
  const identitiesTotal = useUserMemoryStore((s) => s.identitiesTotal);
  const identitiesSearchLoading = useUserMemoryStore((s) => s.identitiesSearchLoading);
  const useFetchIdentities = useUserMemoryStore((s) => s.useFetchIdentities);
  const resetIdentitiesList = useUserMemoryStore((s) => s.resetIdentitiesList);

  // Reset list when search or type filter changes
  useEffect(() => {
    const types = typeFilter === 'all' ? undefined : [typeFilter as TypesEnum];
    resetIdentitiesList({ q: searchValue || undefined, types });
  }, [searchValue, typeFilter]);

  // Call SWR hook to fetch data
  const { isLoading } = useFetchIdentities({
    page: identitiesPage,
    pageSize: 12,
    q: searchValue || undefined,
    types: typeFilter === 'all' ? undefined : [typeFilter as TypesEnum],
  });

  // Handle search and type changes
  const handleSearch = useCallback(
    (value: string) => {
      setSearchValueRaw(value || null);
    },
    [setSearchValueRaw],
  );

  const handleTypeChange = useCallback(
    (type: IdentityType) => {
      setTypeFilterRaw(type === 'all' ? null : type);
    },
    [setTypeFilterRaw],
  );

  // The skeleton is for a genuinely cold list only. A revisit (or a filter
  // refetch) keeps the rows that are already on screen and shows a spinner in
  // the filter bar instead — replacing a populated list with a skeleton on
  // every mount was the flash this page used to have.
  const showLoading = !identitiesInit && identitiesCount === 0;
  const isRefreshing = Boolean(identitiesSearchLoading) && identitiesCount > 0;

  return (
    <Flexbox flex={1} height={'100%'}>
      <NavHeader
        left={
          Boolean(identitiesTotal) && (
            <Tag icon={<Icon icon={BrainCircuitIcon} />}>{identitiesTotal}</Tag>
          )
        }
        right={
          <ActionBar showAnalysis showPurge>
            <ViewModeSwitcher value={viewMode} onChange={setViewMode} />
            <WideScreenButton />
          </ActionBar>
        }
      />
      <Flexbox
        height={'100%'}
        id={SCROLL_PARENT_ID}
        style={{ overflowY: 'auto', paddingBottom: '16vh' }}
        width={'100%'}
      >
        <WideScreenContainer gap={32} paddingBlock={48}>
          <Flexbox horizontal align={'center'} gap={12} justify={'space-between'}>
            <SegmentedBar typeValue={typeFilter} onTypeChange={handleTypeChange} />
            <CommonFilterBar
              loading={isRefreshing}
              searchValue={searchValue}
              onSearch={handleSearch}
            />
          </Flexbox>
          {showLoading ? (
            <DelayedFallback>
              <Loading viewMode={viewMode} />
            </DelayedFallback>
          ) : (
            <List isLoading={isLoading} searchValue={searchValue} viewMode={viewMode} />
          )}
        </WideScreenContainer>
      </Flexbox>
    </Flexbox>
  );
});

const Identities: FC = () => {
  return (
    <>
      <Flexbox horizontal height={'100%'} width={'100%'}>
        <IdentitiesArea />
        <IdentityRightPanel />
      </Flexbox>
      <EditableModal />
    </>
  );
};

export default Identities;
