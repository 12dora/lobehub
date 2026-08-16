'use client';

import { Avatar, Flexbox, Text } from '@lobehub/ui';
import { Button, Input, Switch, toast } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import type { FilterValue } from 'antd/es/table/interface';
import dayjs from 'dayjs';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import type {
  ModerationCategory,
  ModerationDecisionSource,
  ModerationEffectiveAction,
  ModerationRequestKind,
} from '@/const/platform/contentModeration';
import {
  MODERATION_CATEGORIES,
  MODERATION_DECISION_SOURCES,
  MODERATION_EFFECTIVE_ACTIONS,
  MODERATION_REQUEST_KINDS,
} from '@/const/platform/contentModeration';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { ContentModerationRecord } from '@/types/platform/contentModeration';

import {
  dateRangeColumnFilter,
  enumColumnFilter,
  searchColumnFilter,
} from '../../primitives/columnFilters';
import { openDangerConfirm } from '../../primitives/DangerConfirm';
import type { AdminTableChangeMeta } from '../../primitives/DataTable';
import DataTable from '../../primitives/DataTable';
import { runAdminMutation } from '../../primitives/runAdminMutation';
import { formatAdminDateTime } from '../../users/utils';
import {
  categoryLabel,
  decisionSourceLabel,
  displayModerationUser,
  effectiveActionLabel,
  formatLatency,
  formatModelPair,
  formatScore,
  requestKindLabel,
} from '../format';
import { invalidateModerationRecords, useModerationRecords } from '../hooks';
import ManageGuard from '../ManageGuard';
import { adminContentModerationService } from '../service';
import { moderationStyles as styles } from '../styles';
import ActionTag from './ActionTag';
import RecordDetailDrawer from './RecordDetailDrawer';

export const DEFAULT_RECORDS_PAGE_SIZE = 20;

export interface RecordsFilters {
  actions: ModerationEffectiveAction[];
  categories: ModerationCategory[];
  from?: Date;
  /** 显示放行记录 — only meaningful when the settings record non-hits at all. */
  includeNonHits: boolean;
  requestKinds: ModerationRequestKind[];
  search?: string;
  sources: ModerationDecisionSource[];
  to?: Date;
  userQuery?: string;
}

export const emptyRecordsFilters = (): RecordsFilters => ({
  actions: [],
  categories: [],
  includeNonHits: false,
  requestKinds: [],
  sources: [],
});

const toStringList = (value: FilterValue | null | undefined): string[] =>
  value ? value.map(String).filter(Boolean) : [];

const firstNonEmpty = (value: FilterValue | null | undefined): string | undefined =>
  toStringList(value)[0];

const pickFrom = <T extends string>(
  allowed: readonly T[],
  value: FilterValue | null | undefined,
): T[] =>
  toStringList(value).filter((item): item is T => (allowed as readonly string[]).includes(item));

/**
 * The day RangePicker hands back local midnight for BOTH ends, and the server filters with
 * `createdAt < to`. Passing the picked end day straight through therefore drops that whole day.
 * Normalize to a half-open `[startOfFromDay, startOfDayAfterToDay)` window instead.
 */
export const toRangeStart = (value: Date | null | undefined): Date | undefined =>
  value ? dayjs(value).startOf('day').toDate() : undefined;

export const toRangeEndExclusive = (value: Date | null | undefined): Date | undefined =>
  value ? dayjs(value).startOf('day').add(1, 'day').toDate() : undefined;

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

const sameTime = (left?: Date, right?: Date): boolean =>
  (left?.getTime() ?? null) === (right?.getTime() ?? null);

/**
 * `DataTable.onChange` also fires for pagination, so the filter handler must be able to tell
 * "nothing changed" — otherwise paging to 2 would immediately reset back to page 1.
 */
export const recordsFiltersEqual = (left: RecordsFilters, right: RecordsFilters): boolean =>
  sameList(left.actions, right.actions) &&
  sameList(left.categories, right.categories) &&
  sameList(left.requestKinds, right.requestKinds) &&
  sameList(left.sources, right.sources) &&
  left.includeNonHits === right.includeNonHits &&
  left.search === right.search &&
  left.userQuery === right.userQuery &&
  sameTime(left.from, right.from) &&
  sameTime(left.to, right.to);

/**
 * Turn UI state into the `listRecords` input. Kept pure so a test can assert the mapping
 * without rendering a table.
 */
export const buildRecordsListInput = (
  filters: RecordsFilters,
  page: number,
  pageSize: number,
  userId?: string,
) => ({
  actions: filters.actions.length ? filters.actions : undefined,
  categories: filters.categories.length ? filters.categories : undefined,
  from: filters.from,
  includeNonHits: filters.includeNonHits || undefined,
  limit: pageSize,
  offset: (page - 1) * pageSize,
  requestKinds: filters.requestKinds.length ? filters.requestKinds : undefined,
  search: filters.search || undefined,
  sources: filters.sources.length ? filters.sources : undefined,
  to: filters.to,
  userId: userId || undefined,
  userQuery: filters.userQuery || undefined,
});

/**
 * §6.2 user cell: avatar (initials when the list payload carries no image) + identity, linking
 * to 用户管理. The link stops propagation so it does not also open the detail drawer — the row
 * click still owns the drawer.
 */
const UserCell = memo<{ row: ContentModerationRecord }>(({ row }) => {
  const navigate = useNavigate();
  const label = displayModerationUser(row.userSnapshot, row.userId);
  const secondary = row.userSnapshot?.email?.trim() || row.userSnapshot?.username?.trim() || null;
  const initial = label.trim().slice(0, 1).toUpperCase() || '?';

  const identity = (
    <span style={{ alignItems: 'center', display: 'inline-flex', gap: 6, minWidth: 0 }}>
      <Avatar alt={label} avatar={initial} size={20} />
      <Text ellipsis style={{ margin: 0 }}>
        {secondary && secondary !== label ? `${label} · ${secondary}` : label}
      </Text>
    </span>
  );

  if (!row.userId) return identity;

  return (
    <a
      href={`/admin/users/${row.userId}`}
      style={{ color: 'inherit', minWidth: 0 }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        navigate(`/admin/users/${row.userId}`);
      }}
    >
      {identity}
    </a>
  );
});
UserCell.displayName = 'ModerationRecordUserCell';

export interface RecordsTabProps {
  canBanUsers: boolean;
  canManage: boolean;
  enabled: boolean;
}

/**
 * 违规记录 tab (design §6.2). Ignored / allowed rows are excluded by default: the list is an
 * exception log, and mixing in every allowed request would bury the ones that matter.
 */
const RecordsTab = memo<RecordsTabProps>(({ canBanUsers, canManage, enabled }) => {
  const { t } = useTranslation('admin');
  const { authMethod } = useAdminAccess();
  const [params, setParams] = useSearchParams();

  const [filters, setFilters] = useState<RecordsFilters>(emptyRecordsFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_RECORDS_PAGE_SIZE);
  const [selected, setSelected] = useState<string[]>([]);
  const [searchDraft, setSearchDraft] = useState('');
  const [deleting, setDeleting] = useState(false);

  const userId = params.get('userId') ?? undefined;
  const recordId = params.get('recordId');

  const setQueryParam = useCallback(
    (key: string, value?: string) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
      else next.delete(key);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const applyFilters = useCallback((patch: Partial<RecordsFilters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      if (recordsFiltersEqual(prev, next)) return prev;
      setPage(1);
      setSelected([]);
      return next;
    });
  }, []);

  const listInput = useMemo(
    () => buildRecordsListInput(filters, page, pageSize, userId),
    [filters, page, pageSize, userId],
  );

  const { data, error, isLoading, mutate } = useModerationRecords(enabled, listInput);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const handleTableChange = useCallback(
    ({ filters: next }: AdminTableChangeMeta) => {
      applyFilters({
        actions: pickFrom(MODERATION_EFFECTIVE_ACTIONS, next.effectiveAction),
        categories: pickFrom(MODERATION_CATEGORIES, next.topCategory),
        requestKinds: pickFrom(MODERATION_REQUEST_KINDS, next.requestKind),
        sources: pickFrom(MODERATION_DECISION_SOURCES, next.source),
        userQuery: firstNonEmpty(next.userId),
      });
    },
    [applyFilters],
  );

  const handleBulkDelete = () => {
    if (!canManage || selected.length === 0 || deleting) return;
    openDangerConfirm({
      content: t('contentModeration.records.deleteManyConfirm', { count: selected.length }),
      title: t('contentModeration.records.deleteTitle'),
      onConfirm: async () => {
        setDeleting(true);
        try {
          const ok = await runAdminMutation({
            authMethod,
            mapErrorKey: () => 'contentModeration.toast.deleteFailed',
            run: async () => {
              const result = await adminContentModerationService.deleteRecords({ ids: selected });
              toast.success(
                t('contentModeration.toast.deleteSuccess', {
                  count: result.deleted ?? selected.length,
                }),
              );
            },
          });
          if (ok) {
            setSelected([]);
            await invalidateModerationRecords();
          }
        } finally {
          setDeleting(false);
        }
      },
    });
  };

  const columns: TableColumnsType<ContentModerationRecord> = useMemo(
    () => [
      {
        dataIndex: 'createdAt',
        key: 'createdAt',
        title: t('contentModeration.records.columns.time'),
        width: 170,
        ...dateRangeColumnFilter({
          // The picker shows the inclusive last day; `filters.to` holds the exclusive bound.
          value:
            filters.from || filters.to
              ? [
                  filters.from ?? null,
                  filters.to ? dayjs(filters.to).subtract(1, 'day').toDate() : null,
                ]
              : null,
          onChange: (range) =>
            applyFilters({
              from: toRangeStart(range?.[0]),
              to: toRangeEndExclusive(range?.[1]),
            }),
        }),
        render: (value: Date) => formatAdminDateTime(value),
      },
      {
        dataIndex: 'userId',
        key: 'userId',
        title: t('contentModeration.records.columns.user'),
        width: 180,
        ellipsis: true,
        ...searchColumnFilter({
          placeholder: t('contentModeration.records.filters.user'),
          value: filters.userQuery,
          onSearch: (value) => applyFilters({ userQuery: value || undefined }),
        }),
        render: (_: unknown, row) => <UserCell row={row} />,
      },
      {
        dataIndex: 'effectiveAction',
        key: 'effectiveAction',
        title: t('contentModeration.records.columns.action'),
        width: 160,
        ...enumColumnFilter({
          multiple: true,
          options: MODERATION_EFFECTIVE_ACTIONS.map((value) => ({
            label: effectiveActionLabel(t, value),
            value,
          })),
          value: filters.actions,
        }),
        render: (_: unknown, row) => (
          <ActionTag effectiveAction={row.effectiveAction} policyAction={row.policyAction} />
        ),
      },
      {
        dataIndex: 'topCategory',
        key: 'topCategory',
        title: t('contentModeration.records.columns.topCategory'),
        width: 130,
        ...enumColumnFilter({
          multiple: true,
          options: MODERATION_CATEGORIES.map((value) => ({
            label: categoryLabel(t, value),
            value,
          })),
          value: filters.categories,
        }),
        render: (value: string | null) => (value ? categoryLabel(t, value) : '—'),
      },
      {
        dataIndex: 'topScore',
        key: 'topScore',
        title: t('contentModeration.records.columns.topScore'),
        width: 80,
        render: (value: number | null) => formatScore(value),
      },
      {
        dataIndex: 'source',
        key: 'source',
        title: t('contentModeration.records.columns.source'),
        width: 130,
        ...enumColumnFilter({
          multiple: true,
          options: MODERATION_DECISION_SOURCES.map((value) => ({
            label: decisionSourceLabel(t, value),
            value,
          })),
          value: filters.sources,
        }),
        render: (value: string) => decisionSourceLabel(t, value),
      },
      {
        dataIndex: 'requestKind',
        key: 'requestKind',
        title: t('contentModeration.records.columns.requestKind'),
        width: 110,
        ...enumColumnFilter({
          multiple: true,
          options: MODERATION_REQUEST_KINDS.map((value) => ({
            label: requestKindLabel(t, value),
            value,
          })),
          value: filters.requestKinds,
        }),
        render: (value: string) => requestKindLabel(t, value),
      },
      {
        key: 'model',
        title: t('contentModeration.records.columns.model'),
        width: 220,
        ellipsis: true,
        render: (_: unknown, row) =>
          row.effectiveModel
            ? `${formatModelPair(row.provider, row.model)} → ${formatModelPair(row.effectiveProvider, row.effectiveModel)}`
            : formatModelPair(row.provider, row.model),
      },
      {
        dataIndex: 'classifierLatencyMs',
        key: 'classifierLatencyMs',
        title: t('contentModeration.records.columns.latency'),
        width: 90,
        render: (value: number | null) => formatLatency(value),
      },
      {
        dataIndex: 'promptExcerpt',
        key: 'promptExcerpt',
        title: t('contentModeration.records.columns.excerpt'),
        ellipsis: true,
        render: (value: string) => (
          <Text ellipsis style={{ margin: 0 }} type="secondary">
            {value || '—'}
          </Text>
        ),
      },
    ],
    [applyFilters, filters, t],
  );

  const bulkDeleteButton = (
    <ManageGuard allowed={canManage}>
      <Button
        danger
        disabled={!canManage || selected.length === 0 || deleting}
        loading={deleting}
        size="small"
        onClick={handleBulkDelete}
      >
        {t('contentModeration.records.deleteSelected', { count: selected.length })}
      </Button>
    </ManageGuard>
  );

  return (
    <Flexbox className={styles.stack} gap={12}>
      {userId ? (
        <Flexbox horizontal align="center" gap={8}>
          <Text type="secondary">{t('contentModeration.records.filteredByUser', { userId })}</Text>
          <Button size="small" type="text" onClick={() => setQueryParam('userId', undefined)}>
            {t('contentModeration.records.clearUserFilter')}
          </Button>
        </Flexbox>
      ) : null}

      <DataTable<ContentModerationRecord>
        columns={columns}
        dataSource={items}
        emptyDescription={t('contentModeration.records.empty')}
        error={Boolean(error) && !data}
        loading={isLoading && !data}
        rowKey="id"
        scroll={{ x: 1440 }}
        pagination={{
          current: page,
          pageSize,
          pageSizeOptions: ['20', '50', '100'],
          total,
        }}
        rowSelection={{
          onChange: (keys) => setSelected(keys.map(String)),
          selectedRowKeys: selected,
        }}
        toolbar={
          <div className={styles.tableToolbar}>
            <div className={styles.toolbarRow}>
              <Input
                placeholder={t('contentModeration.records.searchPlaceholder')}
                style={{ width: 280 }}
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  applyFilters({ search: searchDraft.trim() || undefined });
                }}
              />
              <Button
                size="small"
                onClick={() => applyFilters({ search: searchDraft.trim() || undefined })}
              >
                {t('contentModeration.records.search')}
              </Button>
              <label className={styles.toolbarRow}>
                <Switch
                  checked={filters.includeNonHits}
                  size="small"
                  onChange={(checked) => applyFilters({ includeNonHits: Boolean(checked) })}
                />
                <span className={styles.hintText}>
                  {t('contentModeration.records.showAllowed')}
                </span>
              </label>
            </div>
            <div className={styles.toolbarRow}>{bulkDeleteButton}</div>
          </div>
        }
        onChange={handleTableChange}
        onRetry={() => void mutate()}
        onRowActivate={(row) => setQueryParam('recordId', row.id)}
        onPaginationChange={(nextPage, nextSize) => {
          setPage(nextSize === pageSize ? nextPage : 1);
          setPageSize(nextSize);
          setSelected([]);
        }}
      />

      <RecordDetailDrawer
        canBanUsers={canBanUsers}
        canManage={canManage}
        open={Boolean(recordId)}
        recordId={recordId}
        onClose={() => setQueryParam('recordId', undefined)}
      />
    </Flexbox>
  );
});

RecordsTab.displayName = 'ModerationRecordsTab';

export default RecordsTab;
