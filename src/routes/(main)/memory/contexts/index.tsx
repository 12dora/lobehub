import { Flexbox, Icon, Tag } from '@lobehub/ui';
import { BrainCircuitIcon } from 'lucide-react';
import { type FC } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import DelayedFallback from '@/components/Loading/DelayedFallback';
import NavHeader from '@/features/NavHeader';
import WideScreenContainer from '@/features/WideScreenContainer';
import WideScreenButton from '@/features/WideScreenContainer/WideScreenButton';
import { useQueryState } from '@/hooks/useQueryParam';
import ActionBar from '@/routes/(main)/memory/features/ActionBar';
import { SCROLL_PARENT_ID } from '@/routes/(main)/memory/features/TimeLineView/useScrollParent';
import { useUserMemoryStore } from '@/store/userMemory';

import EditableModal from '../features/EditableModal';
import FilterBar from '../features/FilterBar';
import Loading from '../features/Loading';
import { type ViewMode } from '../features/ViewModeSwitcher';
import ViewModeSwitcher from '../features/ViewModeSwitcher';
import ContextRightPanel from './features/ContextRightPanel';
import List from './features/List';

const ContextsArea = memo(() => {
  const { t } = useTranslation('memory');
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [searchValueRaw, setSearchValueRaw] = useQueryState('q', { clearOnDefault: true });
  const [sortValueRaw, setSortValueRaw] = useQueryState('sort', { clearOnDefault: true });

  const searchValue = searchValueRaw || '';
  const sortValue: 'capturedAt' | 'scoreImpact' | 'scoreUrgency' =
    sortValueRaw === 'scoreImpact' || sortValueRaw === 'scoreUrgency' ? sortValueRaw : 'capturedAt';

  const contextsCount = useUserMemoryStore((s) => s.contexts.length);
  const contextsPage = useUserMemoryStore((s) => s.contextsPage);
  const contextsInit = useUserMemoryStore((s) => s.contextsInit);
  const contextsTotal = useUserMemoryStore((s) => s.contextsTotal);
  const contextsSearchLoading = useUserMemoryStore((s) => s.contextsSearchLoading);
  const useFetchContexts = useUserMemoryStore((s) => s.useFetchContexts);
  const resetContextsList = useUserMemoryStore((s) => s.resetContextsList);

  const sortOptions = [
    { label: t('filter.sort.createdAt'), value: 'capturedAt' },
    { label: t('filter.sort.scoreImpact'), value: 'scoreImpact' },
    { label: t('filter.sort.scoreUrgency'), value: 'scoreUrgency' },
  ];

  // Convert sort: capturedAt becomes undefined (backend default)
  const apiSort =
    sortValue === 'capturedAt' ? undefined : (sortValue as 'scoreImpact' | 'scoreUrgency');

  // Reset list when search or sort changes
  useEffect(() => {
    const sort = viewMode === 'grid' ? apiSort : undefined;
    resetContextsList({ q: searchValue || undefined, sort });
  }, [searchValue, apiSort, viewMode]);

  // Call SWR hook to fetch data
  const { isLoading } = useFetchContexts({
    page: contextsPage,
    pageSize: 12,
    q: searchValue || undefined,
    sort: viewMode === 'grid' ? apiSort : undefined,
  });

  // Handle search and sort changes
  const handleSearch = useCallback(
    (value: string) => {
      setSearchValueRaw(value || null);
    },
    [setSearchValueRaw],
  );

  const handleSortChange = useCallback(
    (sort: string) => {
      setSortValueRaw(sort);
    },
    [setSortValueRaw],
  );

  // Show loading: during search/reset or initial load
  // The skeleton is for a genuinely cold list only. A revisit (or a filter
  // refetch) keeps the rows that are already on screen and shows a spinner in
  // the filter bar instead — replacing a populated list with a skeleton on
  // every mount was the flash this page used to have.
  const showLoading = !contextsInit && contextsCount === 0;
  const isRefreshing = Boolean(contextsSearchLoading) && contextsCount > 0;

  return (
    <Flexbox flex={1} height={'100%'}>
      <NavHeader
        left={
          Boolean(contextsTotal) && (
            <Tag icon={<Icon icon={BrainCircuitIcon} />}>{contextsTotal}</Tag>
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
          <FilterBar
            loading={isRefreshing}
            searchValue={searchValue}
            sortOptions={viewMode === 'grid' ? sortOptions : undefined}
            sortValue={sortValue}
            onSearch={handleSearch}
            onSortChange={viewMode === 'grid' ? handleSortChange : undefined}
          />
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

const Contexts: FC = () => {
  return (
    <>
      <Flexbox horizontal height={'100%'} width={'100%'}>
        <ContextsArea />
        <ContextRightPanel />
      </Flexbox>
      <EditableModal />
    </>
  );
};

export default Contexts;
