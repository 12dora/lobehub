import { Flexbox, Icon, Tag } from '@lobehub/ui';
import { BrainCircuitIcon } from 'lucide-react';
import { type FC } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
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
import ExperienceRightPanel from './features/ExperienceRightPanel';
import List from './features/List';

const ExperiencesArea = memo(() => {
  const { t } = useTranslation('memory');
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [searchValueRaw, setSearchValueRaw] = useQueryState('q', { clearOnDefault: true });
  const [sortValueRaw, setSortValueRaw] = useQueryState('sort', { clearOnDefault: true });

  const searchValue = searchValueRaw || '';
  const sortValue: 'capturedAt' | 'scoreConfidence' =
    sortValueRaw === 'scoreConfidence' ? 'scoreConfidence' : 'capturedAt';

  const experiencesCount = useUserMemoryStore((s) => s.experiences.length);
  const experiencesError = useUserMemoryStore((s) => s.experiencesError);
  const experiencesPage = useUserMemoryStore((s) => s.experiencesPage);
  const experiencesSearchLoading = useUserMemoryStore((s) => s.experiencesSearchLoading);
  const experiencesSettled = useUserMemoryStore((s) => s.experiencesSettled);
  const experiencesTotal = useUserMemoryStore((s) => s.experiencesTotal);
  const useFetchExperiences = useUserMemoryStore((s) => s.useFetchExperiences);
  const resetExperiencesList = useUserMemoryStore((s) => s.resetExperiencesList);

  const sortOptions = [
    { label: t('filter.sort.createdAt'), value: 'capturedAt' },
    { label: t('filter.sort.scoreConfidence'), value: 'scoreConfidence' },
  ];

  // Convert sort: capturedAt becomes undefined (backend default)
  const apiSort = sortValue === 'capturedAt' ? undefined : (sortValue as 'scoreConfidence');

  // One source of truth for "which rows belong on screen". The store guards
  // every write with this same identity, so the reset effect and the fetch can
  // never disagree about which query the list is showing.
  const listQuery = useMemo(
    () => ({ q: searchValue || undefined, sort: viewMode === 'grid' ? apiSort : undefined }),
    [searchValue, apiSort, viewMode],
  );

  // Reset list when the query changes. A no-op in the store when the query is
  // the one already on screen (a revisit must not blank the list), which is why
  // this can run unconditionally and still catch the switch back to the default
  // sort — the old `if (!apiSort) return` guard swallowed exactly that.
  useEffect(() => {
    resetExperiencesList(listQuery);
  }, [listQuery, resetExperiencesList]);

  // Call SWR hook to fetch data
  const {
    error: fetchError,
    isLoading,
    mutate: revalidate,
  } = useFetchExperiences({ ...listQuery, page: experiencesPage, pageSize: 12 });

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

  const error = experiencesError ?? fetchError;

  // Three states, in precedence order:
  // - cold: nothing to show and the first page is still in flight → skeleton.
  // - failed: the query on screen never settled → reason + Retry. Without this
  //   a cold failure sat on the skeleton forever, and a failed filter change
  //   silently presented the *previous* query's rows as the new results.
  // - otherwise the list, which may still be the previous query's rows while a
  //   filter change resolves — the filter bar spinner says so.
  const showError = Boolean(error) && !experiencesSettled;
  const showLoading = !experiencesSettled && experiencesCount === 0 && !error;
  const isRefreshing = Boolean(experiencesSearchLoading) && experiencesCount > 0;

  const handleRetry = useCallback(() => {
    // Re-arm the loading state (clears the stored error) before revalidating.
    resetExperiencesList(listQuery);
    void revalidate();
  }, [listQuery, resetExperiencesList, revalidate]);

  return (
    <Flexbox flex={1} height={'100%'}>
      <NavHeader
        left={
          Boolean(experiencesTotal) && (
            <Tag icon={<Icon icon={BrainCircuitIcon} />}>{experiencesTotal}</Tag>
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

const Experiences: FC = () => {
  return (
    <>
      <Flexbox horizontal height={'100%'} width={'100%'}>
        <ExperiencesArea />
        <ExperienceRightPanel />
      </Flexbox>
      <EditableModal />
    </>
  );
};

export default Experiences;
