import { Flexbox, Icon, Tag } from '@lobehub/ui';
import { BrainCircuitIcon } from 'lucide-react';
import { type FC } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import AsyncError from '@/components/AsyncError';
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
  const identitiesError = useUserMemoryStore((s) => s.identitiesError);
  const identitiesPage = useUserMemoryStore((s) => s.identitiesPage);
  const identitiesSearchLoading = useUserMemoryStore((s) => s.identitiesSearchLoading);
  const identitiesSettled = useUserMemoryStore((s) => s.identitiesSettled);
  const identitiesTotal = useUserMemoryStore((s) => s.identitiesTotal);
  const useFetchIdentities = useUserMemoryStore((s) => s.useFetchIdentities);
  const resetIdentitiesList = useUserMemoryStore((s) => s.resetIdentitiesList);

  // One source of truth for "which rows belong on screen". The store guards
  // every write with this same identity, so the reset effect and the fetch can
  // never disagree about which query the list is showing.
  const listQuery = useMemo(
    () => ({
      q: searchValue || undefined,
      types: typeFilter === 'all' ? undefined : [typeFilter as TypesEnum],
    }),
    [searchValue, typeFilter],
  );

  // Reset list when search or type filter changes. A no-op in the store when
  // the query is the one already on screen (a revisit must not blank the list).
  useEffect(() => {
    resetIdentitiesList(listQuery);
  }, [listQuery, resetIdentitiesList]);

  // Call SWR hook to fetch data
  const {
    error: fetchError,
    isLoading,
    mutate: revalidate,
  } = useFetchIdentities({ ...listQuery, page: identitiesPage, pageSize: 12 });

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

  const error = identitiesError ?? fetchError;

  // Three states, in precedence order:
  // - cold: nothing to show and the first page is still in flight → skeleton.
  // - failed: the query on screen never settled → reason + Retry. Without this
  //   a cold failure sat on the skeleton forever, and a failed filter change
  //   silently presented the *previous* query's rows as the new results.
  // - otherwise the list, which may still be the previous query's rows while a
  //   filter change resolves — the filter bar spinner says so.
  const showError = Boolean(error) && !identitiesSettled;
  const showLoading = !identitiesSettled && identitiesCount === 0 && !error;
  const isRefreshing = Boolean(identitiesSearchLoading) && identitiesCount > 0;

  const handleRetry = useCallback(() => {
    // Re-arm the loading state (clears the stored error) before revalidating.
    resetIdentitiesList(listQuery);
    void revalidate();
  }, [listQuery, resetIdentitiesList, revalidate]);

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
          ) : showError ? (
            <AsyncError error={error} variant={'block'} onRetry={handleRetry} />
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
