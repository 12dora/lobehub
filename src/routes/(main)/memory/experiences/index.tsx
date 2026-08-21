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
  const experiencesPage = useUserMemoryStore((s) => s.experiencesPage);
  const experiencesInit = useUserMemoryStore((s) => s.experiencesInit);
  const experiencesTotal = useUserMemoryStore((s) => s.experiencesTotal);
  const experiencesSearchLoading = useUserMemoryStore((s) => s.experiencesSearchLoading);
  const useFetchExperiences = useUserMemoryStore((s) => s.useFetchExperiences);
  const resetExperiencesList = useUserMemoryStore((s) => s.resetExperiencesList);

  const sortOptions = [
    { label: t('filter.sort.createdAt'), value: 'capturedAt' },
    { label: t('filter.sort.scoreConfidence'), value: 'scoreConfidence' },
  ];

  // Convert sort: capturedAt becomes undefined (backend default)
  const apiSort = sortValue === 'capturedAt' ? undefined : (sortValue as 'scoreConfidence');

  // Reset list when search or sort changes
  useEffect(() => {
    // No `if (!apiSort) return` here: that guard existed to stop the mount-time
    // reset from wiping the list, and it also swallowed the switch *back* to
    // the default sort. The store now no-ops on an unchanged query, so the
    // effect can run unconditionally and every sort change lands.
    const sort = viewMode === 'grid' ? apiSort : undefined;
    resetExperiencesList({ q: searchValue || undefined, sort });
  }, [searchValue, apiSort, viewMode]);

  // Call SWR hook to fetch data
  const { isLoading } = useFetchExperiences({
    page: experiencesPage,
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
  const showLoading = !experiencesInit && experiencesCount === 0;
  const isRefreshing = Boolean(experiencesSearchLoading) && experiencesCount > 0;

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
