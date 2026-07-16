'use client';

import { Center, Empty, Flexbox, SearchBar, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { SkillsIcon } from '@lobehub/ui/icons';
import { memo, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import { usePublishedSkillCatalog } from '@/enterprise/client/features/skills';
import { useToolStore } from '@/store/tool';

import PlatformSkillItem from './PlatformSkillItem';
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

const PlatformSkillList = memo<PlatformSkillListProps>(({ onSelect, selectedIdentifier }) => {
  const { t } = useTranslation('setting');
  const runtimeEnforced = useToolStore((state) => state.platformSkillRuntimeEnforced);
  const runtimeStatus = useToolStore((state) => state.platformSkillRuntimeStatus);
  const catalog = usePublishedSkillCatalog(runtimeEnforced);
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q')?.trim() ?? '';
  const requestedPage = parsePage(searchParams.get('page'));
  const filteredSkills = useMemo(() => {
    const normalized = query.toLocaleLowerCase();
    if (!normalized) return catalog.data?.skills ?? [];
    return (catalog.data?.skills ?? []).filter((skill) =>
      `${skill.displayName} ${skill.skillKey} ${skill.description ?? ''}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [catalog.data?.skills, query]);
  const pageCount = Math.max(1, Math.ceil(filteredSkills.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const pageSkills = filteredSkills.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const locatedSelectionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (runtimeStatus !== 'ready' || !catalog.data) return;
    const locationKey = `${catalog.data.revision}\0${query}\0${selectedIdentifier ?? ''}`;
    if (locatedSelectionRef.current === locationKey) return;
    locatedSelectionRef.current = locationKey;
    let nextPage = page;
    if (selectedIdentifier) {
      const selectedIndex = filteredSkills.findIndex(
        (skill) => skill.skillKey === selectedIdentifier,
      );
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

  if (runtimeStatus === 'error' || (catalog.error && !catalog.data?.skills.length)) {
    return (
      <Center paddingBlock={48}>
        <AsyncError error={catalog.error} variant="block" onRetry={() => void catalog.mutate()} />
      </Center>
    );
  }
  if (runtimeStatus === 'loading' || (catalog.isLoading && !catalog.data)) {
    return <Loading debugId="Settings > Skill > Published catalog" />;
  }
  if (runtimeStatus !== 'ready' || !catalog.data?.skills.length) {
    return (
      <Center paddingBlock={48}>
        <Empty
          description={t('platformSkills.empty.desc')}
          icon={SkillsIcon}
          title={t('platformSkills.empty.title')}
        />
      </Center>
    );
  }
  const catalogData = catalog.data;

  return (
    <Flexbox gap={8}>
      <SearchBar
        allowClear
        aria-label={t('platformSkills.search.label')}
        placeholder={t('platformSkills.search.placeholder')}
        value={query}
        onInputChange={setQuery}
      />
      {catalog.error ? (
        <AsyncError error={catalog.error} variant="block" onRetry={() => void catalog.mutate()} />
      ) : null}
      {filteredSkills.length === 0 ? (
        <Center paddingBlock={32}>
          <Empty
            description={t('platformSkills.search.emptyDesc')}
            icon={SkillsIcon}
            title={t('platformSkills.search.emptyTitle')}
          />
        </Center>
      ) : (
        pageSkills.map((skill) => (
          <PlatformSkillItem
            isSelected={selectedIdentifier === skill.skillKey}
            key={`${catalogData.revision}:${skill.skillKey}`}
            skill={skill}
            onSelect={() => onSelect?.(skill.skillKey, 'platform-skill')}
          />
        ))
      )}
      {filteredSkills.length > PAGE_SIZE ? (
        <Flexbox horizontal align="center" justify="space-between" paddingBlock={8}>
          <Button
            aria-label={t('platformSkills.pagination.previous')}
            disabled={page <= 1}
            size="small"
            onClick={() => setPage(page - 1)}
          >
            {t('platformSkills.pagination.previous')}
          </Button>
          <Text type="secondary">
            {t('platformSkills.pagination.status', { page, pages: pageCount })}
          </Text>
          <Button
            aria-label={t('platformSkills.pagination.next')}
            disabled={page >= pageCount}
            size="small"
            onClick={() => setPage(page + 1)}
          >
            {t('platformSkills.pagination.next')}
          </Button>
        </Flexbox>
      ) : null}
    </Flexbox>
  );
});

PlatformSkillList.displayName = 'PlatformSkillList';

export default PlatformSkillList;
