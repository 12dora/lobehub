'use client';

import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Switch } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import DataTable from '@/enterprise/client/features/admin/primitives/DataTable';
import type { AdminSystemInstancesState } from '@/enterprise/client/features/admin/system/hooks/useAdminSystem';
import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';
import type { AdminSystemInstanceRevisions } from '@/enterprise/client/services/adminSystem';

type Instance = AdminSystemInstanceRevisions['items'][number];

const PAGE_SIZE = 10;

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
      [t],
    );

    const items = state.data?.items ?? [];
    const counts = state.data?.counts ?? null;
    const paginated = items.length > PAGE_SIZE;
    const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const current = Math.min(page, pageCount);
    const visible = paginated ? items.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE) : items;

    return (
      <Flexbox gap={8}>
        <Flexbox horizontal align="center" gap={12} justify="space-between" wrap="wrap">
          <Text type="secondary">
            {counts
              ? t('system.instances.counts', { live: counts.live, offline: counts.offline })
              : null}
          </Text>
          <Flexbox horizontal align="center" gap={8}>
            <Text type="secondary">{t('system.instances.filter.showOffline')}</Text>
            <Switch
              aria-label={t('system.instances.filter.showOffline')}
              checked={showOffline}
              onChange={(value) => {
                setPage(1);
                onShowOfflineChange(Boolean(value));
              }}
            />
          </Flexbox>
        </Flexbox>
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
          emptyDescription={t(showOffline ? 'system.instances.emptyAll' : 'system.instances.empty')}
          error={Boolean(state.initialError)}
          loading={state.isLoadingInitial}
          rowKey="instanceId"
          size="small"
          pagination={
            paginated
              ? {
                  current,
                  pageSize: PAGE_SIZE,
                  showSizeChanger: false,
                  total: items.length,
                }
              : false
          }
          onPaginationChange={setPage}
          onRetry={() => void state.refresh()}
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
        ) : items.length ? (
          <div className={styles.footer}>
            <Text type="secondary">{t('system.instances.end')}</Text>
          </div>
        ) : null}
      </Flexbox>
    );
  },
);

InstancesTable.displayName = 'AdminSystemInstancesTable';
