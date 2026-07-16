'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import DataTable from '../../primitives/DataTable';
import StatusBadge from '../../primitives/StatusBadge';
import { deriveAiCatalogPermissions } from '../controller';
import { useFetchAdminAiProviders } from '../hooks/useAdminAiCatalog';
import type { AdminAiProviderListInput, AdminAiProviderListItem } from '../types';

const DEFAULT_LIMIT = 50;

const styles = createStaticStyles(({ css }) => ({
  identity: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
}));

const ProviderListPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { permissions } = useAdminAccess();
  const { canUpdateProvider } = deriveAiCatalogPermissions(permissions);
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') as AdminAiProviderListInput['status'];
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const cursor = cursorStack.at(-1) ?? null;
  const input = useMemo<AdminAiProviderListInput>(
    () => ({ cursor: cursor ?? undefined, limit, status: status || undefined }),
    [cursor, limit, status],
  );
  const { data, error, isLoading, mutate } = useFetchAdminAiProviders(input);

  const columns = useMemo<TableColumnsType<AdminAiProviderListItem>>(
    () => [
      {
        key: 'provider',
        title: t('aiCatalog.providers.columns.provider'),
        render: (_, item) => (
          <div className={styles.identity}>
            <Text ellipsis strong>
              {item.displayName}
            </Text>
            <Text ellipsis type="secondary">
              {item.providerKey}
            </Text>
          </div>
        ),
      },
      {
        dataIndex: 'status',
        key: 'status',
        title: t('aiCatalog.providers.columns.status'),
        render: (value: string) => <StatusBadge status={value} />,
      },
      {
        dataIndex: 'enabled',
        key: 'enabled',
        title: t('aiCatalog.providers.columns.enabled'),
        render: (value: boolean) => (
          <Tag color={value ? 'success' : 'default'}>
            {t(`aiCatalog.common.boolean.${value}` as never)}
          </Tag>
        ),
      },
      {
        dataIndex: 'source',
        key: 'source',
        title: t('aiCatalog.providers.columns.source'),
      },
      {
        dataIndex: 'secret',
        key: 'secret',
        title: t('aiCatalog.providers.columns.secret'),
        render: (secret: AdminAiProviderListItem['secret']) => (
          <Tag color={secret.configured ? 'success' : 'warning'}>
            {t(
              secret.configured
                ? 'aiCatalog.providers.secret.configured'
                : 'aiCatalog.providers.secret.missing',
            )}
          </Tag>
        ),
      },
      {
        dataIndex: 'revision',
        key: 'revision',
        title: t('aiCatalog.providers.columns.revision'),
      },
    ],
    [t],
  );

  const patchStatus = useCallback(
    (next: string | undefined) => {
      const params = new URLSearchParams(searchParams);
      if (next) params.set('status', next);
      else params.delete('status');
      setSearchParams(params, { replace: true });
      setCursorStack([]);
    },
    [searchParams, setSearchParams],
  );

  return (
    <AdminPageTemplate
      description={t('aiCatalog.providers.desc')}
      title={t('aiCatalog.providers.title')}
      toolbar={
        <Flexbox horizontal gap={8}>
          <Select
            allowClear
            aria-label={t('aiCatalog.providers.filters.status')}
            placeholder={t('aiCatalog.providers.filters.status')}
            style={{ minWidth: 160 }}
            value={status || undefined}
            options={(['draft', 'published', 'archived'] as const).map((value) => ({
              label: t(`aiCatalog.status.${value}` as never),
              value,
            }))}
            onChange={(value) => patchStatus(value as string | undefined)}
          />
        </Flexbox>
      }
    >
      <DataTable<AdminAiProviderListItem>
        columns={columns}
        dataSource={data?.items}
        error={Boolean(error) && !data}
        loading={isLoading && !data}
        pagination={false}
        rowKey="id"
        cursorPagination={{
          hasNext: Boolean(data?.nextCursor),
          hasPrevious: cursorStack.length > 0,
          pageSize: limit,
          onNext: () => {
            if (!data?.nextCursor) return;
            setCursorStack((current) => [...current, data.nextCursor]);
          },
          onPageSizeChange: (pageSize) => {
            setLimit(pageSize);
            setCursorStack([]);
          },
          onPrevious: () => setCursorStack((current) => current.slice(0, -1)),
        }}
        emptyDescription={
          status ? t('aiCatalog.providers.empty.filtered') : t('aiCatalog.providers.empty.default')
        }
        onRetry={() => void mutate()}
        onRowActivate={
          canUpdateProvider
            ? (item) => navigate(`/admin/ai/providers/${encodeURIComponent(item.id)}`)
            : undefined
        }
      />
    </AdminPageTemplate>
  );
});

ProviderListPage.displayName = 'AdminAiProviderListPage';

export default ProviderListPage;
