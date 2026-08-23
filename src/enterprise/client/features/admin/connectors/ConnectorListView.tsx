'use client';

import { Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import type { FilterValue } from 'antd/es/table/interface';
import { createStaticStyles } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { enumColumnFilter } from '../primitives/columnFilters';
import DataTable, {
  type AdminCursorPagination,
  type AdminTableChangeMeta,
} from '../primitives/DataTable';
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
    justify-content: flex-start;
    width: 100%;
  `,
  toolbarSearch: css`
    flex: 0 1 260px;
    min-width: 180px;
    max-width: 320px;
  `,
}));

const firstFilterValue = (value: FilterValue | null | undefined): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === null || first === '') return undefined;
  return String(first);
};

interface ConnectorListViewProps {
  // Forwarded verbatim to DataTable, so it stays on the shared cursor contract rather than a
  // local copy that can drift from it.
  cursorPagination: AdminCursorPagination;
  data?: AdminConnectorListItem[];
  error?: boolean;
  filters: Pick<AdminConnectorListInput, 'credentialMode' | 'enabled' | 'query' | 'status'>;
  loading?: boolean;
  onColumnFiltersChange: (next: {
    credentialMode?: string;
    enabled?: string;
    status?: string;
  }) => void;
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
    onColumnFiltersChange,
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
          ...enumColumnFilter({
            options: (['draft', 'published', 'archived'] as const).map((value) => ({
              label: t(`connectorCatalog.status.${value}` as never),
              value,
            })),
            value: filters.status,
          }),
        },
        {
          dataIndex: 'credentialMode',
          key: 'credentialMode',
          render: (mode: AdminConnectorListItem['credentialMode']) => (
            <Tag>{t(`connectorCatalog.credentialMode.${mode}` as never)}</Tag>
          ),
          title: t('connectorCatalog.list.columns.credentialMode'),
          ...enumColumnFilter({
            options: (['none', 'shared_service_account', 'per_user_oauth'] as const).map(
              (value) => ({
                label: t(`connectorCatalog.credentialMode.${value}` as never),
                value,
              }),
            ),
            value: filters.credentialMode,
          }),
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
          ...enumColumnFilter({
            options: (['true', 'false'] as const).map((value) => ({
              label: t(`connectorCatalog.boolean.${value}` as never),
              value,
            })),
            value: filters.enabled === undefined ? undefined : String(filters.enabled),
          }),
        },
        {
          dataIndex: 'revision',
          key: 'revision',
          title: t('connectorCatalog.list.columns.revision'),
        },
      ],
      [filters.credentialMode, filters.enabled, filters.status, t],
    );

    const handleTableChange = ({ filters: nextFilters }: AdminTableChangeMeta) => {
      const next: {
        credentialMode?: string;
        enabled?: string;
        status?: string;
      } = {};
      if ('credentialMode' in nextFilters) {
        next.credentialMode = firstFilterValue(nextFilters.credentialMode);
      }
      if ('enabled' in nextFilters) {
        next.enabled = firstFilterValue(nextFilters.enabled);
      }
      if ('status' in nextFilters) {
        next.status = firstFilterValue(nextFilters.status);
      }
      if (Object.keys(next).length === 0) return;
      onColumnFiltersChange(next);
    };
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
          toolbar={
            <Flexbox horizontal className={styles.toolbar} data-testid="connector-list-toolbar">
              <div className={styles.toolbarSearch}>
                <Input
                  allowClear
                  aria-label={t('connectorCatalog.filters.query')}
                  placeholder={t('connectorCatalog.filters.query')}
                  style={{ width: '100%' }}
                  value={filters.query ?? ''}
                  onChange={(event) => onFilterChange('query', event.target.value || undefined)}
                />
              </div>
            </Flexbox>
          }
          onChange={handleTableChange}
          onRetry={onRetry}
          onRowActivate={permissions.canRead ? (item) => onOpen(item.id) : undefined}
        />
      </AdminPageTemplate>
    );
  },
);

ConnectorListView.displayName = 'AdminConnectorListView';

export default ConnectorListView;
