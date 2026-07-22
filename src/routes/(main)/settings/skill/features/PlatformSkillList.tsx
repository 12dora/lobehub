'use client';

import { memo, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { usePublishedSkillCatalog } from '@/enterprise/client/features/skills';
import { useToolStore } from '@/store/tool';

import SkillCatalogListView, { type SkillCatalogListEntry } from './catalog/SkillCatalogListView';
import type { ToolDetailType } from './SkillDetail';

interface PlatformSkillListProps {
  onSelect?: (identifier: string, type: ToolDetailType) => void;
  selectedIdentifier?: string;
}

const PAGE_SIZE = 50;

const parsePage = (value: string | null) => {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
};

/**
 * User managed skill list — binds platform.skills published catalog into the
 * shared SkillCatalogListView. Admin pages inject admin.skills via their own
 * parent and never share this hook (no draft/secret leakage).
 */
const PlatformSkillList = memo<PlatformSkillListProps>(({ onSelect, selectedIdentifier }) => {
  const { t } = useTranslation('setting');
  const runtimeManaged = useToolStore((state) => state.platformSkillRuntimeManaged);
  const runtimeStatus = useToolStore((state) => state.platformSkillRuntimeStatus);
  const catalog = usePublishedSkillCatalog(runtimeManaged);
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q')?.trim() ?? '';
  const requestedPage = parsePage(searchParams.get('page'));

  const items: SkillCatalogListEntry[] = useMemo(
    () =>
      (catalog.data?.skills ?? []).map((skill) => ({
        description: skill.description,
        displayName: skill.displayName,
        distribution: skill.distribution,
        id: skill.skillKey,
        skillKey: skill.skillKey,
        source: skill.source,
        translateBadges: true,
        version: skill.version,
      })),
    [catalog.data?.skills],
  );

  const filteredSkills = useMemo(() => {
    const normalized = query.toLocaleLowerCase();
    if (!normalized) return items;
    return items.filter((skill) =>
      `${skill.displayName} ${skill.skillKey} ${skill.description ?? ''}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [items, query]);
  const pageCount = Math.max(1, Math.ceil(filteredSkills.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);

  const locatedSelectionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (runtimeStatus !== 'ready' || !catalog.data) return;
    const locationKey = `${catalog.data.revision}\0${query}\0${selectedIdentifier ?? ''}`;
    if (locatedSelectionRef.current === locationKey) return;
    locatedSelectionRef.current = locationKey;
    let nextPage = page;
    if (selectedIdentifier) {
      const selectedIndex = filteredSkills.findIndex((skill) => skill.id === selectedIdentifier);
      if (selectedIndex >= 0) nextPage = Math.floor(selectedIndex / PAGE_SIZE) + 1;
    }
    if (requestedPage === nextPage) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('page', String(nextPage));
    setSearchParams(nextParams, { replace: true });
  }, [
    catalog.data,
    filteredSkills,
    page,
    query,
    requestedPage,
    runtimeStatus,
    searchParams,
    selectedIdentifier,
    setSearchParams,
  ]);

  useEffect(() => {
    if (runtimeStatus !== 'ready' || !catalog.data || requestedPage <= pageCount) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('page', String(pageCount));
    setSearchParams(nextParams, { replace: true });
  }, [catalog.data, pageCount, requestedPage, runtimeStatus, searchParams, setSearchParams]);

  const setPage = (nextPage: number) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('page', String(nextPage));
    setSearchParams(nextParams);
  };

  const setQuery = (value: string) => {
    const nextParams = new URLSearchParams(searchParams);
    if (value.trim()) nextParams.set('q', value);
    else nextParams.delete('q');
    nextParams.set('page', '1');
    setSearchParams(nextParams, { replace: true });
  };

  // Match prior UX: hard error when runtime/catalog failed with nothing to show.
  const hardError =
    runtimeStatus === 'error' || (catalog.error && !catalog.data?.skills.length)
      ? catalog.error
      : catalog.error && catalog.data?.skills.length
        ? catalog.error
        : undefined;
  const isLoading = runtimeStatus === 'loading' || (catalog.isLoading && !catalog.data);
  // Treat non-ready (except error) without data as loading so we don't flash empty.
  const showLoading =
    isLoading || (runtimeStatus !== 'ready' && runtimeStatus !== 'error' && !catalog.data);
  // Only pass items when ready (or soft-error with partial data).
  const listItems =
    runtimeStatus === 'ready' || (catalog.data?.skills.length && runtimeStatus !== 'error')
      ? items
      : [];

  return (
    <SkillCatalogListView
      emptyDesc={t('platformSkills.empty.desc')}
      emptyTitle={t('platformSkills.empty.title')}
      error={hardError}
      isLoading={showLoading}
      items={listItems}
      loadingDebugId="Settings > Skill > Published catalog"
      query={query}
      searchEmptyDesc={t('platformSkills.search.emptyDesc')}
      searchEmptyTitle={t('platformSkills.search.emptyTitle')}
      searchLabel={t('platformSkills.search.label')}
      searchPlaceholder={t('platformSkills.search.placeholder')}
      selectedId={selectedIdentifier}
      setQuery={setQuery}
      pagination={{
        labels: {
          next: t('platformSkills.pagination.next'),
          previous: t('platformSkills.pagination.previous'),
          status: (p, pages) => t('platformSkills.pagination.status', { page: p, pages }),
        },
        page,
        pageSize: PAGE_SIZE,
        setPage,
      }}
      onRetry={() => void catalog.mutate()}
      onSelect={(id) => onSelect?.(id, 'platform-skill')}
    />
  );
});

PlatformSkillList.displayName = 'PlatformSkillList';

export default PlatformSkillList;
