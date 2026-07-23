'use client';

import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import DataTable from '@/enterprise/client/features/admin/primitives/DataTable';
import type { AdminSystemInstancesState } from '@/enterprise/client/features/admin/system/hooks/useAdminSystem';
import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';
import type { AdminSystemInstanceRevisions } from '@/enterprise/client/services/adminSystem';

type Instance = AdminSystemInstanceRevisions['items'][number];

const styles = createStaticStyles(({ css }) => ({
  footer: css`
    display: flex;
    justify-content: center;
    padding-block: 8px;
  `,
}));

export interface InstancesTableProps {
  state: AdminSystemInstancesState;
}

export const InstancesTable = memo<InstancesTableProps>(({ state }) => {
  const { t } = useTranslation('admin');
  const columns = useMemo<TableColumnsType<Instance>>(
    () => [
      {
        dataIndex: 'instanceKind',
        key: 'instanceKind',
        render: (kind: string) => <Text>{t(`system.values.instanceKind.${kind}` as never)}</Text>,
        title: t('system.instances.columns.instance'),
      },
      {
        key: 'health',
        render: (_, instance) => (
          <Flexbox horizontal gap={8} wrap="wrap">
            <Tag color={instance.fresh ? 'success' : 'warning'} size="small">
              {t(instance.fresh ? 'system.instances.fresh' : 'system.instances.stale')}
            </Tag>
            {instance.pendingRestart ? (
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
        dataIndex: 'lastHeartbeatAt',
        key: 'lastHeartbeatAt',
        render: (value: Date) => <Text>{formatAdminDateTime(value)}</Text>,
        title: t('system.instances.columns.heartbeat'),
        width: 200,
      },
    ],
    [t],
  );

  return (
    <Flexbox gap={8}>
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
        dataSource={state.data?.items}
        emptyDescription={t('system.instances.empty')}
        error={Boolean(state.initialError)}
        loading={state.isLoadingInitial}
        pagination={false}
        rowKey="instanceId"
        size="small"
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
      ) : state.data?.items.length ? (
        <div className={styles.footer}>
          <Text type="secondary">{t('system.instances.end')}</Text>
        </div>
      ) : null}
    </Flexbox>
  );
});

InstancesTable.displayName = 'AdminSystemInstancesTable';
