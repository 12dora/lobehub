'use client';

import { Center, Empty, Flexbox, SearchBar, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { SkillsIcon } from '@lobehub/ui/icons';
import { memo, useMemo } from 'react';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';

import PlatformSkillItem, { type PlatformSkillListPresentation } from '../PlatformSkillItem';

export interface SkillCatalogListEntry extends PlatformSkillListPresentation {
  description?: string | null;
  extraBadges?: string[];
  /** Stable selection id (skillKey for user published; draft id / builtin: for admin). */
  id: string;
  skillKey?: string;
  translateBadges?: boolean;
}

export interface SkillCatalogListViewProps {
  emptyDesc: string;
  emptyTitle: string;
  error?: unknown;
  isLoading?: boolean;
  items: SkillCatalogListEntry[];
  loadingDebugId?: string;
  onRetry?: () => void;
  onSelect?: (id: string) => void;
  /**
   * Optional pagination. When omitted, all filtered items render.
   * User published catalog uses page size 50; admin typically shows full list.
   */
  pagination?: {
    page: number;
    pageSize: number;
    setPage: (page: number) => void;
    labels: {
      next: string;
      previous: string;
      status: (page: number, pages: number) => string;
    };
  };
  /** Client-side filter query controlled by parent (admin) or URL (user). */
  query: string;
  searchEmptyDesc: string;
  searchEmptyTitle: string;
  searchLabel: string;
  searchPlaceholder: string;
  selectedId?: string;
  setQuery: (value: string) => void;
  /** Inline notice when list partially loaded (e.g. builtins only after admin API error). */
  softError?: React.ReactNode;
}

/**
 * Presentational skill catalog list — shared by user managed settings and
 * admin AI skills. Parents inject data; this component never calls admin.* APIs.
 */
const SkillCatalogListView = memo<SkillCatalogListViewProps>(
  ({
    emptyDesc,
    emptyTitle,
    error,
    isLoading,
    items,
    loadingDebugId = 'Settings > Skill > Catalog',
    onRetry,
    onSelect,
    pagination,
    query,
    searchEmptyDesc,
    searchEmptyTitle,
    searchLabel,
    searchPlaceholder,
    selectedId,
    setQuery,
    softError,
  }) => {
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = useMemo(() => {
      if (!normalized) return items;
      return items.filter((skill) => {
        const haystack = [
          skill.displayName,
          skill.id,
          skill.skillKey ?? '',
          skill.source,
          skill.distribution,
          skill.description ?? '',
        ]
          .join(' ')
          .toLocaleLowerCase();
        return haystack.includes(normalized);
      });
    }, [items, normalized]);

    const pageSize = pagination?.pageSize ?? Math.max(filtered.length, 1);
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = pagination ? Math.min(pagination.page, pageCount) : 1;
    const pageItems = pagination
      ? filtered.slice((page - 1) * pageSize, page * pageSize)
      : filtered;

    if (error && items.length === 0) {
      return (
        <Center paddingBlock={48}>
          <AsyncError error={error} variant="block" onRetry={onRetry} />
        </Center>
      );
    }
    if (isLoading && items.length === 0) {
      return <Loading debugId={loadingDebugId} />;
    }
    if (!isLoading && items.length === 0) {
      return (
        <Center paddingBlock={48}>
          <Empty description={emptyDesc} icon={SkillsIcon} title={emptyTitle} />
        </Center>
      );
    }

    return (
      <Flexbox gap={8}>
        <SearchBar
          allowClear
          aria-label={searchLabel}
          placeholder={searchPlaceholder}
          value={query}
          onInputChange={setQuery}
          onSearch={setQuery}
        />
        {softError}
        {error && items.length > 0 ? (
          <AsyncError error={error} variant="block" onRetry={onRetry} />
        ) : null}
        {filtered.length === 0 ? (
          <Center paddingBlock={32}>
            <Empty description={searchEmptyDesc} icon={SkillsIcon} title={searchEmptyTitle} />
          </Center>
        ) : (
          pageItems.map((skill) => (
            <PlatformSkillItem
              extraBadges={skill.extraBadges}
              isSelected={selectedId === skill.id}
              key={skill.id}
              skill={skill}
              translateBadges={skill.translateBadges}
              onSelect={() => onSelect?.(skill.id)}
            />
          ))
        )}
        {pagination && filtered.length > pageSize ? (
          <Flexbox horizontal align="center" justify="space-between" paddingBlock={8}>
            <Button
              aria-label={pagination.labels.previous}
              disabled={page <= 1}
              size="small"
              onClick={() => pagination.setPage(page - 1)}
            >
              {pagination.labels.previous}
            </Button>
            <Text type="secondary">{pagination.labels.status(page, pageCount)}</Text>
            <Button
              aria-label={pagination.labels.next}
              disabled={page >= pageCount}
              size="small"
              onClick={() => pagination.setPage(page + 1)}
            >
              {pagination.labels.next}
            </Button>
          </Flexbox>
        ) : null}
      </Flexbox>
    );
  },
);

SkillCatalogListView.displayName = 'SkillCatalogListView';

export default SkillCatalogListView;
