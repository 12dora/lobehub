'use client';

import { Alert, Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Button, Select, toast } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminAiCatalogService } from '@/enterprise/client/services/adminAiCatalog';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import DataTable from '../../primitives/DataTable';
import StatusBadge from '../../primitives/StatusBadge';
import { deriveAiCatalogPermissions } from '../controller';
import { refreshAdminAiProviderLists, useFetchAdminAiProviders } from '../hooks/useAdminAiCatalog';
import { commitThenScheduleRefresh } from '../mutationRefresh';
import type { AdminAiProviderListInput, AdminAiProviderListItem } from '../types';
import {
  createUrlBackedTextFilter,
  editUrlBackedTextFilter,
  resolveUrlBackedTextCommit,
  syncUrlBackedTextFilter,
} from '../urlFilterController';
import { openCreateProviderModal } from './openCreateProviderModal';

const DEFAULT_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 300;

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
  const { authMethod, permissions } = useAdminAccess();
  const { canCreateProvider, canReadProviders } = deriveAiCatalogPermissions(permissions);
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') as AdminAiProviderListInput['status'];
  const enabledParam = searchParams.get('enabled');
  const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;
  const query = searchParams.get('q') ?? '';
  const source = searchParams.get('source') ?? '';
  const [searchFilter, setSearchFilter] = useState(() => createUrlBackedTextFilter(query));
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [committedProviderId, setCommittedProviderId] = useState<string | null>(null);
  const [committedRefreshFailed, setCommittedRefreshFailed] = useState(false);
  const [committedRefreshRetrying, setCommittedRefreshRetrying] = useState(false);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const searchTimerRef = useRef<number | null>(null);
  const cursor = cursorStack.at(-1) ?? null;
  const input = useMemo<AdminAiProviderListInput>(
    () => ({
      cursor: cursor ?? undefined,
      enabled,
      limit,
      query: query || undefined,
      source: source || undefined,
      status: status || undefined,
    }),
    [cursor, enabled, limit, query, source, status],
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

  const patchFilter = useCallback(
    (key: 'enabled' | 'q' | 'status', next: string | undefined) => {
      const params = new URLSearchParams(searchParams);
      if (next) params.set(key, next);
      else params.delete(key);
      setSearchParams(params, { replace: true });
      setCursorStack([]);
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    setSearchFilter((current) => syncUrlBackedTextFilter(current, query));
  }, [query]);

  useEffect(() => {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      const next = resolveUrlBackedTextCommit(searchFilter, query);
      if (next === null) return;
      patchFilter('q', next);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    };
  }, [patchFilter, query, searchFilter]);

  const filtered = Boolean(status || enabledParam || query || source);

  const retryCommittedRefresh = async () => {
    if (!committedProviderId) return;
    setCommittedRefreshRetrying(true);
    try {
      await refreshAdminAiProviderLists();
      const id = committedProviderId;
      setCommittedProviderId(null);
      setCommittedRefreshFailed(false);
      navigate(`/admin/ai/catalog/providers/${encodeURIComponent(id)}`);
    } catch {
      setCommittedRefreshFailed(true);
    } finally {
      setCommittedRefreshRetrying(false);
    }
  };

  return (
    <AdminPageTemplate
      description={t('aiCatalog.providers.desc')}
      title={t('aiCatalog.providers.title')}
      actions={
        canCreateProvider ? (
          <Button
            type="primary"
            onClick={() =>
              openCreateProviderModal({
                authMethod: authMethod ?? undefined,
                onSubmit: async (input) => {
                  let providerId = '';
                  await commitThenScheduleRefresh({
                    commit: () => adminAiCatalogService.createProvider(input),
                    refresh: refreshAdminAiProviderLists,
                    onCommitted: (provider) => {
                      providerId = provider.id;
                      setCommittedProviderId(provider.id);
                      setCommittedRefreshFailed(false);
                      toast.success(t('aiCatalog.toast.providerCreated'));
                    },
                    onRefreshed: () => {
                      setCommittedProviderId(null);
                      navigate(`/admin/ai/catalog/providers/${encodeURIComponent(providerId)}`);
                    },
                    onRefreshFailed: () => setCommittedRefreshFailed(true),
                  });
                },
              })
            }
          >
            {t('aiCatalog.providers.actions.create')}
          </Button>
        ) : null
      }
      toolbar={
        <Flexbox horizontal gap={8}>
          <Input
            allowClear
            aria-label={t('aiCatalog.providers.filters.query')}
            placeholder={t('aiCatalog.providers.filters.query')}
            style={{ minWidth: 240 }}
            value={searchFilter.draft}
            onChange={(event) =>
              setSearchFilter(editUrlBackedTextFilter(event.target.value, query))
            }
          />
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
            onChange={(value) => patchFilter('status', value as string | undefined)}
          />
          <Select
            allowClear
            aria-label={t('aiCatalog.providers.filters.enabled')}
            placeholder={t('aiCatalog.providers.filters.enabled')}
            style={{ minWidth: 140 }}
            value={enabledParam || undefined}
            options={[
              { label: t('aiCatalog.common.boolean.true'), value: 'true' },
              { label: t('aiCatalog.common.boolean.false'), value: 'false' },
            ]}
            onChange={(value) => patchFilter('enabled', value as string | undefined)}
          />
        </Flexbox>
      }
    >
      {committedRefreshFailed ? (
        <Alert
          showIcon
          description={t('aiCatalog.refresh.committed.desc')}
          message={t('aiCatalog.refresh.committed.title')}
          type="warning"
          extra={
            <Button loading={committedRefreshRetrying} onClick={() => void retryCommittedRefresh()}>
              {t('aiCatalog.refresh.retry')}
            </Button>
          }
        />
      ) : null}
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
          filtered
            ? t('aiCatalog.providers.empty.filtered')
            : t('aiCatalog.providers.empty.default')
        }
        onRetry={() => void mutate()}
        onRowActivate={
          canReadProviders
            ? (item) => navigate(`/admin/ai/catalog/providers/${encodeURIComponent(item.id)}`)
            : undefined
        }
      />
    </AdminPageTemplate>
  );
});

ProviderListPage.displayName = 'AdminAiProviderListPage';

export default ProviderListPage;
