'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, Input, Switch, toast } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import {
  MODERATION_CATEGORIES,
  MODERATION_DECISION_SOURCES,
  MODERATION_EFFECTIVE_ACTIONS,
  MODERATION_REQUEST_KINDS,
} from '@/const/platform/contentModeration';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { ContentModerationRecord } from '@/types/platform/contentModeration';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import type { AdminTableChangeMeta } from '../../primitives/DataTable';
import DataTable from '../../primitives/DataTable';
import { runAdminMutation } from '../../primitives/runAdminMutation';
import { invalidateModerationRecords, useModerationRecords } from '../hooks';
import ManageGuard from '../ManageGuard';
import { adminContentModerationService } from '../service';
import { moderationStyles as styles } from '../styles';
import RecordDetailDrawer from './RecordDetailDrawer';
import { buildRecordsColumns } from './recordsColumns';
import {
  buildRecordsListInput,
  DEFAULT_RECORDS_PAGE_SIZE,
  emptyRecordsFilters,
  firstNonEmpty,
  pickFrom,
  type RecordsFilters,
  recordsFiltersEqual,
} from './recordsFilters';

export {
  buildRecordsListInput,
  DEFAULT_RECORDS_PAGE_SIZE,
  emptyRecordsFilters,
  type RecordsFilters,
  recordsFiltersEqual,
  toRangeEndExclusive,
  toRangeStart,
} from './recordsFilters';

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
    () => buildRecordsColumns({ applyFilters, filters, t }),
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
