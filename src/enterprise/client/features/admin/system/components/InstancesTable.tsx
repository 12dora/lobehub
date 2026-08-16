'use client';

import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import type { FilterValue } from 'antd/es/table/interface';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { enumColumnFilter } from '@/enterprise/client/features/admin/primitives/columnFilters';
import DataTable, {
  type AdminTableChangeMeta,
} from '@/enterprise/client/features/admin/primitives/DataTable';
import type { AdminSystemInstancesState } from '@/enterprise/client/features/admin/system/hooks/useAdminSystem';
import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';
import type { AdminSystemInstanceRevisions } from '@/enterprise/client/services/adminSystem';

type Instance = AdminSystemInstanceRevisions['items'][number];

const DEFAULT_PAGE_SIZE = 20;

const INSTANCE_STATUS = {
  all: 'all',
  offline: 'offline',
  online: 'online',
} as const;

type InstanceStatusFilter = (typeof INSTANCE_STATUS)[keyof typeof INSTANCE_STATUS];

const firstFilterValue = (value: FilterValue | null | undefined): string | undefined => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null || raw === '') return undefined;
  return String(raw);
};

const parseInstanceStatus = (value: unknown): InstanceStatusFilter => {
  if (value === INSTANCE_STATUS.offline || value === INSTANCE_STATUS.all) return value;
  return INSTANCE_STATUS.online;
};

/** Registry ids carry 48 hex chars of process entropy; the first 8 already disambiguate a row. */
const shortInstanceId = (instanceId: string) =>
  instanceId.replace(/^(?:oidci_|pinst_)/, '').slice(0, 8);

const styles = createStaticStyles(({ css }) => ({
  code: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    font-variant-numeric: tabular-nums;
  `,
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

    const columns = useMemo<TableColumnsType<Instance>>(
      () => [
        {
          key: 'instance',
          render: (_, instance) => (
            <Flexbox gap={2}>
              <Text>{t(`system.values.instanceKind.${instance.instanceKind}` as never)}</Text>
              <Text className={styles.code} type="secondary">
                {shortInstanceId(instance.instanceId)}
              </Text>
            </Flexbox>
          ),
          title: t('system.instances.columns.instance'),
        },
        {
          key: 'health',
          render: (_, instance) => (
            <Flexbox horizontal gap={8} wrap="wrap">
              <Tag color={instance.fresh ? 'success' : 'default'} size="small">
                {t(instance.fresh ? 'system.instances.fresh' : 'system.instances.stale')}
              </Tag>
              {/* An offline process can never act on a restart, so the badge would be noise. */}
              {instance.fresh && instance.pendingRestart ? (
                <Tag color="warning" size="small">
                  {t('system.instances.pendingRestart')}
                </Tag>
              ) : null}
            </Flexbox>
          ),
          title: t('system.instances.columns.health'),
          width: 200,
          ...enumColumnFilter({
            options: [
              { label: t('system.instances.fresh'), value: INSTANCE_STATUS.online },
              { label: t('system.instances.stale'), value: INSTANCE_STATUS.offline },
              { label: t('system.instances.filter.all'), value: INSTANCE_STATUS.all },
            ],
            value: statusFilter,
          }),
        },
        {
          dataIndex: 'startedAt',
          key: 'startedAt',
          render: (value: Date) => (
            <Text className={styles.code}>{formatAdminDateTime(value)}</Text>
          ),
          title: t('system.instances.columns.startedAt'),
          width: 200,
        },
        {
          dataIndex: 'lastHeartbeatAt',
          key: 'lastHeartbeatAt',
          render: (value: Date) => (
            <Text className={styles.code}>{formatAdminDateTime(value)}</Text>
          ),
          title: t('system.instances.columns.heartbeat'),
          width: 200,
        },
      ],
      [statusFilter, t],
    );

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
