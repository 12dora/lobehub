'use client';

import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import DataTable from '@/enterprise/client/features/admin/primitives/DataTable';
import { formatRevisionToken } from '@/enterprise/client/features/admin/system/controller';
import type { AdminSystemInstancesState } from '@/enterprise/client/features/admin/system/hooks/useAdminSystem';
import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';
import type { AdminSystemInstanceRevisions } from '@/enterprise/client/services/adminSystem';

import { OperationalStatus } from './OperationalStatus';

type Instance = AdminSystemInstanceRevisions['items'][number];

const styles = createStaticStyles(({ css }) => ({
  code: css`
    font-family: ${cssVar.fontFamilyCode};
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  `,
  domainList: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
    min-width: 360px;
  `,
  domainRow: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;
  `,
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
        dataIndex: 'instanceId',
        key: 'instanceId',
        render: (id: string, instance) => (
          <Flexbox gap={4}>
            <Text className={styles.code}>{id}</Text>
            <Text type="secondary">
              {t(`system.values.instanceKind.${instance.instanceKind}` as never)}
            </Text>
          </Flexbox>
        ),
        title: t('system.instances.columns.instance'),
        width: 250,
      },
      {
        key: 'health',
        render: (_, instance) => (
          <Flexbox horizontal gap={8} wrap="wrap">
            <Tag color={instance.fresh ? 'success' : 'warning'} size="small">
              {t(instance.fresh ? 'system.instances.fresh' : 'system.instances.stale')}
            </Tag>
            {instance.lagging ? (
              <Tag color="error" size="small">
                {t('system.instances.lagging')}
              </Tag>
            ) : null}
            {instance.pendingRestart ? (
              <Tag color="warning" size="small">
                {t('system.instances.pendingRestart')}
              </Tag>
            ) : null}
          </Flexbox>
        ),
        title: t('system.instances.columns.health'),
        width: 180,
      },
      {
        dataIndex: 'lastHeartbeatAt',
        key: 'lastHeartbeatAt',
        render: (value: Date) => <Text className={styles.code}>{formatAdminDateTime(value)}</Text>,
        title: t('system.instances.columns.heartbeat'),
        width: 180,
      },
      {
        key: 'domains',
        render: (_, instance) => (
          <div className={styles.domainList}>
            {instance.domains.map((domain) => (
              <div className={styles.domainRow} key={domain.domain}>
                <Flexbox gap={4}>
                  <Text>{t(`system.values.domain.${domain.domain}` as never)}</Text>
                  <Text className={styles.code} type="secondary">
                    {formatRevisionToken(domain.loadedToken)}
                  </Text>
                </Flexbox>
                <OperationalStatus status={domain.status} />
              </div>
            ))}
          </div>
        ),
        title: t('system.instances.columns.domains'),
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
        scroll={{ x: 1050 }}
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
