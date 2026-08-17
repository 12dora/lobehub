'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { FilterValue } from 'antd/es/table/interface';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import DataTable, {
  type AdminTableChangeMeta,
} from '@/enterprise/client/features/admin/primitives/DataTable';
import type { AdminSystemInstancesState } from '@/enterprise/client/features/admin/system/hooks/useAdminSystem';
import type { AdminSystemInstanceRevisions } from '@/enterprise/client/services/adminSystem';

import {
  buildInstancesColumns,
  INSTANCE_STATUS,
  type InstanceStatusFilter,
} from './instancesColumns';

type Instance = AdminSystemInstanceRevisions['items'][number];

const DEFAULT_PAGE_SIZE = 20;

const firstFilterValue = (value: FilterValue | null | undefined): string | undefined => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null || raw === '') return undefined;
  return String(raw);
};

const parseInstanceStatus = (value: unknown): InstanceStatusFilter => {
  if (value === INSTANCE_STATUS.offline || value === INSTANCE_STATUS.all) return value;
  return INSTANCE_STATUS.online;
};

const styles = createStaticStyles(({ css }) => ({
  footer: css`
    display: flex;
    justify-content: center;
    padding-block: 8px;
  `,
}));

export interface InstancesTableProps {
  onShowOfflineChange: (showOffline: boolean) => void;
  showOffline: boolean;
  state: AdminSystemInstancesState;
}

export const InstancesTable = memo<InstancesTableProps>(
  ({ onShowOfflineChange, showOffline, state }) => {
    const { t } = useTranslation('admin');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
    const [statusFilter, setStatusFilter] = useState<InstanceStatusFilter>(() =>
      showOffline ? INSTANCE_STATUS.all : INSTANCE_STATUS.online,
    );

    const applyStatusFilter = useCallback(
      (next: InstanceStatusFilter) => {
        if (next === statusFilter) return;
        setStatusFilter(next);
        setPage(1);
        const needsAll = next !== INSTANCE_STATUS.online;
        if (needsAll !== showOffline) onShowOfflineChange(needsAll);
      },
      [onShowOfflineChange, showOffline, statusFilter],
    );

    const handleTableChange = useCallback(
      ({ filters }: AdminTableChangeMeta) => {
        if (!Object.hasOwn(filters, 'health')) return;
        applyStatusFilter(parseInstanceStatus(firstFilterValue(filters.health)));
      },
      [applyStatusFilter],
    );

    const columns = useMemo(() => buildInstancesColumns({ statusFilter, t }), [statusFilter, t]);

    const items = state.data?.items;
    const counts = state.data?.counts ?? null;
    const filteredItems = useMemo(() => {
      const rows = items ?? [];
      if (statusFilter === INSTANCE_STATUS.offline) return rows.filter((item) => !item.fresh);
      if (statusFilter === INSTANCE_STATUS.online) return rows.filter((item) => item.fresh);
      return rows;
    }, [items, statusFilter]);
    const paginated = filteredItems.length > pageSize;
    const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
    const current = Math.min(page, pageCount);
    const visible = paginated
      ? filteredItems.slice((current - 1) * pageSize, current * pageSize)
      : filteredItems;
    const emptyDescription =
      statusFilter === INSTANCE_STATUS.all
        ? t('system.instances.emptyAll')
        : statusFilter === INSTANCE_STATUS.offline
          ? t('system.instances.emptyOffline')
          : t('system.instances.empty');

    return (
      <Flexbox gap={8}>
        {counts ? (
          <Text type="secondary">
            {t('system.instances.counts', { live: counts.live, offline: counts.offline })}
          </Text>
        ) : null}
        {state.backgroundError && state.data ? (
          <Alert
            showIcon
            message={t('system.instances.refreshFailed')}
            type="warning"
            action={
              <Button size="small" onClick={() => void state.refresh()}>
                {t('system.actions.retry')}
              </Button>
            }
          />
        ) : null}
        <DataTable<Instance>
          columns={columns}
          dataSource={visible}
          emptyDescription={emptyDescription}
          error={Boolean(state.initialError)}
          loading={state.isLoadingInitial}
          rowKey="instanceId"
          size="small"
          pagination={
            paginated
              ? {
                  current,
                  pageSize,
                  total: filteredItems.length,
                }
              : false
          }
          onChange={handleTableChange}
          onRetry={() => void state.refresh()}
          onPaginationChange={(nextPage, nextPageSize) => {
            setPage(nextPage);
            setPageSize(nextPageSize);
          }}
        />
        {state.loadMoreError ? (
          <Alert
            showIcon
            message={t('system.instances.loadMoreFailed')}
            type="error"
            action={
              <Button size="small" onClick={state.retryLoadMore}>
                {t('system.actions.retry')}
              </Button>
            }
          />
        ) : state.hasMore ? (
          <div className={styles.footer}>
            <Button
              disabled={state.isLoadingMore}
              loading={state.isLoadingMore}
              onClick={state.loadMore}
            >
              {t('system.instances.loadMore')}
            </Button>
          </div>
        ) : items?.length ? (
          <div className={styles.footer}>
            <Text type="secondary">{t('system.instances.end')}</Text>
          </div>
        ) : null}
      </Flexbox>
    );
  },
);

InstancesTable.displayName = 'AdminSystemInstancesTable';
