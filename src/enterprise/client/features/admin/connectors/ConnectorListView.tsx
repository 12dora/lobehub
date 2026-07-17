'use client';

import { Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable from '../primitives/DataTable';
import StatusBadge from '../primitives/StatusBadge';
import type { AdminConnectorPermissions } from './controller';
import type { AdminConnectorListInput, AdminConnectorListItem } from './types';

const styles = createStaticStyles(({ css }) => ({
  identity: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
  toolbar: css`
    flex-wrap: wrap;
  `,
}));

interface ConnectorListViewProps {
  cursorPagination: {
    hasNext: boolean;
    hasPrevious: boolean;
    onNext: () => void;
    onPageSizeChange: (pageSize: number) => void;
    onPrevious: () => void;
    pageSize: number;
  };
  data?: AdminConnectorListItem[];
  error?: boolean;
  filters: Pick<AdminConnectorListInput, 'credentialMode' | 'enabled' | 'query' | 'status'>;
  loading?: boolean;
  onCreate: () => void;
  onFilterChange: (
    key: 'credentialMode' | 'enabled' | 'query' | 'status',
    value: string | undefined,
  ) => void;
  onOpen: (connectorId: string) => void;
  onRetry: () => void;
  permissions: AdminConnectorPermissions;
}

const ConnectorListView = memo<ConnectorListViewProps>(
  ({
    cursorPagination,
    data,
    error,
    filters,
    loading,
    onCreate,
    onFilterChange,
    onOpen,
    onRetry,
    permissions,
  }) => {
    const { t } = useTranslation('admin');
    const columns = useMemo<TableColumnsType<AdminConnectorListItem>>(
      () => [
        {
          key: 'connector',
          render: (_, item) => (
            <div className={styles.identity}>
              <Text ellipsis strong>
                {item.displayName}
              </Text>
              <Text ellipsis type={'secondary'}>
                {item.key}
              </Text>
            </div>
          ),
          title: t('connectorCatalog.list.columns.connector'),
        },
        {
          dataIndex: 'status',
          key: 'status',
          render: (status: string) => <StatusBadge status={status} />,
          title: t('connectorCatalog.list.columns.status'),
        },
        {
          dataIndex: 'credentialMode',
          key: 'credentialMode',
          render: (mode: AdminConnectorListItem['credentialMode']) => (
            <Tag>{t(`connectorCatalog.credentialMode.${mode}` as never)}</Tag>
          ),
          title: t('connectorCatalog.list.columns.credentialMode'),
        },
        {
          dataIndex: 'enabled',
          key: 'enabled',
          render: (enabled: boolean) => (
            <Tag color={enabled ? 'success' : 'default'}>
              {t(`connectorCatalog.boolean.${enabled}` as never)}
            </Tag>
          ),
          title: t('connectorCatalog.list.columns.enabled'),
        },
        {
          dataIndex: 'revision',
          key: 'revision',
          title: t('connectorCatalog.list.columns.revision'),
        },
      ],
      [t],
    );
    const filtered = Boolean(
      filters.query || filters.status || filters.credentialMode || filters.enabled !== undefined,
    );

    return (
      <AdminPageTemplate
        description={t('connectorCatalog.list.description')}
        title={t('connectorCatalog.list.title')}
        actions={
          permissions.canCreate ? (
            <Button type={'primary'} onClick={onCreate}>
              {t('connectorCatalog.actions.create')}
            </Button>
          ) : null
        }
        toolbar={
          <Flexbox horizontal className={styles.toolbar} gap={8}>
            <Input
              allowClear
              aria-label={t('connectorCatalog.filters.query')}
              placeholder={t('connectorCatalog.filters.query')}
              style={{ minWidth: 240 }}
              value={filters.query ?? ''}
              onChange={(event) => onFilterChange('query', event.target.value || undefined)}
            />
            <Select
              allowClear
              aria-label={t('connectorCatalog.filters.status')}
              placeholder={t('connectorCatalog.filters.status')}
              style={{ minWidth: 140 }}
              value={filters.status}
              options={(['draft', 'published', 'archived'] as const).map((value) => ({
                label: t(`connectorCatalog.status.${value}` as never),
                value,
              }))}
              onChange={(value) => onFilterChange('status', value as string | undefined)}
            />
            <Select
              allowClear
              aria-label={t('connectorCatalog.filters.credentialMode')}
              placeholder={t('connectorCatalog.filters.credentialMode')}
              style={{ minWidth: 180 }}
              value={filters.credentialMode}
              options={(['none', 'shared_service_account', 'per_user_oauth'] as const).map(
                (value) => ({
                  label: t(`connectorCatalog.credentialMode.${value}` as never),
                  value,
                }),
              )}
              onChange={(value) => onFilterChange('credentialMode', value as string | undefined)}
            />
            <Select
              allowClear
              aria-label={t('connectorCatalog.filters.enabled')}
              placeholder={t('connectorCatalog.filters.enabled')}
              style={{ minWidth: 140 }}
              value={filters.enabled === undefined ? undefined : String(filters.enabled)}
              options={(['true', 'false'] as const).map((value) => ({
                label: t(`connectorCatalog.boolean.${value}` as never),
                value,
              }))}
              onChange={(value) => onFilterChange('enabled', value as string | undefined)}
            />
          </Flexbox>
        }
      >
        <DataTable<AdminConnectorListItem>
          columns={columns}
          cursorPagination={cursorPagination}
          dataSource={data}
          error={error}
          loading={loading}
          pagination={false}
          rowKey={'id'}
          emptyDescription={t(
            filtered
              ? 'connectorCatalog.list.empty.filtered'
              : 'connectorCatalog.list.empty.default',
          )}
          onRetry={onRetry}
          onRowActivate={permissions.canRead ? (item) => onOpen(item.id) : undefined}
        />
      </AdminPageTemplate>
    );
  },
);

ConnectorListView.displayName = 'AdminConnectorListView';

export default ConnectorListView;
