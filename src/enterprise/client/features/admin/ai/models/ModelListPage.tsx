'use client';

import { ActionIcon, Alert, Flexbox, Input, Tag, Text, Tooltip } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, TrashIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import DataTable from '../../primitives/DataTable';
import StatusBadge from '../../primitives/StatusBadge';
import { deriveAiCatalogPermissions } from '../controller';
import { useFetchAdminAiModels } from '../hooks/useAdminAiCatalog';
import { useGlobalModelActions } from '../hooks/useGlobalModelActions';
import type { AdminAiModelListInput, AdminAiModelListItem } from '../types';
import {
  createUrlBackedTextFilter,
  editUrlBackedTextFilter,
  resolveUrlBackedTextCommit,
  syncUrlBackedTextFilter,
} from '../urlFilterController';
import { openModelProviderTargetModal } from './openModelProviderTargetModal';

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

const MODEL_TYPES = [
  'asr',
  'chat',
  'embedding',
  'image',
  'realtime',
  'text2music',
  'tts',
  'video',
] as const;

const ModelListPage = memo(() => {
  const { t } = useTranslation('admin');
  const { authMethod, permissions } = useAdminAccess();
  const permission = deriveAiCatalogPermissions(permissions);
  const modelActions = useGlobalModelActions({
    authMethod: authMethod ?? null,
    permissions: permission,
  });
  const [searchParams, setSearchParams] = useSearchParams();
  const enabledParam = searchParams.get('enabled');
  const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;
  const provider = searchParams.get('provider') ?? '';
  const query = searchParams.get('q') ?? '';
  const status = searchParams.get('status') as AdminAiModelListInput['status'];
  const type = (searchParams.get('type') ?? '') as AdminAiModelListInput['type'] | '';
  const [searchFilter, setSearchFilter] = useState(() => createUrlBackedTextFilter(query));
  const [providerFilter, setProviderFilter] = useState(() => createUrlBackedTextFilter(provider));
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const timerRef = useRef<number | null>(null);
  const providerTimerRef = useRef<number | null>(null);
  const cursor = cursorStack.at(-1) ?? null;

  const patchFilter = useCallback(
    (key: 'enabled' | 'provider' | 'q' | 'status' | 'type', value: string | undefined) => {
      const params = new URLSearchParams(searchParams);
      if (value) params.set(key, value);
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
    setProviderFilter((current) => syncUrlBackedTextFilter(current, provider));
  }, [provider]);

  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const next = resolveUrlBackedTextCommit(searchFilter, query);
      if (next === null) return;
      patchFilter('q', next);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [patchFilter, query, searchFilter]);

  useEffect(() => {
    if (providerTimerRef.current) window.clearTimeout(providerTimerRef.current);
    providerTimerRef.current = window.setTimeout(() => {
      const next = resolveUrlBackedTextCommit(providerFilter, provider);
      if (next === null) return;
      patchFilter('provider', next);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (providerTimerRef.current) window.clearTimeout(providerTimerRef.current);
    };
  }, [patchFilter, provider, providerFilter]);

  const input = useMemo<AdminAiModelListInput>(
    () => ({
      cursor: cursor ?? undefined,
      enabled,
      limit,
      provider: provider || undefined,
      query: query || undefined,
      status: status || undefined,
      type: type || undefined,
    }),
    [cursor, enabled, limit, provider, query, status, type],
  );
  const { data, error, isLoading, mutate } = useFetchAdminAiModels(input);
  const columns = useMemo<TableColumnsType<AdminAiModelListItem>>(
    () => [
      {
        key: 'model',
        title: t('aiCatalog.models.columns.model'),
        render: (_, item) => (
          <div className={styles.identity}>
            <Text ellipsis strong>
              {item.displayName || item.modelKey}
            </Text>
            <Text ellipsis type="secondary">
              {item.providerKey}/{item.modelKey}
            </Text>
          </div>
        ),
      },
      {
        dataIndex: 'type',
        key: 'type',
        title: t('aiCatalog.models.columns.type'),
      },
      {
        dataIndex: 'status',
        key: 'status',
        title: t('aiCatalog.models.columns.status'),
        render: (value: string) => <StatusBadge status={value} />,
      },
      {
        dataIndex: 'enabled',
        key: 'enabled',
        title: t('aiCatalog.models.columns.enabled'),
        render: (value: boolean) => (
          <Tag color={value ? 'success' : 'default'}>
            {t(`aiCatalog.common.boolean.${value}` as never)}
          </Tag>
        ),
      },
      {
        dataIndex: 'contextWindowTokens',
        key: 'contextWindowTokens',
        title: t('aiCatalog.models.columns.context'),
        render: (value: number | null) => value?.toLocaleString() ?? '—',
      },
      {
        dataIndex: 'revision',
        key: 'revision',
        title: t('aiCatalog.models.columns.revision'),
      },
      ...(modelActions.allowed.canCreate ||
      modelActions.allowed.canDelete ||
      modelActions.allowed.canEdit ||
      modelActions.allowed.canReorder
        ? [
            {
              key: 'actions',
              title: t('aiCatalog.models.columns.actions'),
              render: (_: unknown, item: AdminAiModelListItem) => {
                const loading = modelActions.actionLoadingId === item.id;
                return (
                  <Flexbox horizontal gap={4}>
                    {modelActions.allowed.canCreate ? (
                      <Tooltip title={t('aiCatalog.models.actions.createForProvider')}>
                        <ActionIcon
                          disabled={loading}
                          icon={PlusIcon}
                          size="small"
                          onClick={() => {
                            void modelActions.handleCreate(item.providerId).catch(() => undefined);
                          }}
                        />
                      </Tooltip>
                    ) : null}
                    {modelActions.allowed.canReorder ? (
                      <>
                        <Tooltip title={t('aiCatalog.models.actions.moveUp')}>
                          <ActionIcon
                            disabled={loading}
                            icon={ArrowUpIcon}
                            size="small"
                            onClick={() => void modelActions.handleReorder(item, -1)}
                          />
                        </Tooltip>
                        <Tooltip title={t('aiCatalog.models.actions.moveDown')}>
                          <ActionIcon
                            disabled={loading}
                            icon={ArrowDownIcon}
                            size="small"
                            onClick={() => void modelActions.handleReorder(item, 1)}
                          />
                        </Tooltip>
                      </>
                    ) : null}
                    {modelActions.allowed.canEdit ? (
                      <Tooltip title={t('aiCatalog.models.actions.edit')}>
                        <ActionIcon
                          disabled={loading}
                          icon={PencilIcon}
                          size="small"
                          onClick={() => void modelActions.handleEdit(item)}
                        />
                      </Tooltip>
                    ) : null}
                    {modelActions.allowed.canDelete ? (
                      <Tooltip title={t('aiCatalog.models.actions.delete')}>
                        <ActionIcon
                          disabled={loading}
                          icon={TrashIcon}
                          size="small"
                          onClick={() => void modelActions.handleDelete(item)}
                        />
                      </Tooltip>
                    ) : null}
                  </Flexbox>
                );
              },
            },
          ]
        : []),
    ],
    [modelActions, t],
  );

  const filtered = Boolean(enabledParam || provider || query || status || type);

  return (
    <AdminPageTemplate
      description={t('aiCatalog.models.desc')}
      title={t('aiCatalog.models.title')}
      actions={
        modelActions.allowed.canCreate ? (
          <Button
            type="primary"
            onClick={() => {
              openModelProviderTargetModal({
                onSubmit: modelActions.handleCreate,
              });
            }}
          >
            {t('aiCatalog.models.actions.create')}
          </Button>
        ) : null
      }
      toolbar={
        <Flexbox horizontal gap={8} style={{ flexWrap: 'wrap' }}>
          <Input
            allowClear
            aria-label={t('aiCatalog.models.filters.query')}
            placeholder={t('aiCatalog.models.filters.query')}
            style={{ minWidth: 220 }}
            value={searchFilter.draft}
            onChange={(event) =>
              setSearchFilter(editUrlBackedTextFilter(event.target.value, query))
            }
          />
          <Input
            allowClear
            aria-label={t('aiCatalog.models.filters.provider')}
            placeholder={t('aiCatalog.models.filters.provider')}
            style={{ minWidth: 180 }}
            value={providerFilter.draft}
            onChange={(event) =>
              setProviderFilter(editUrlBackedTextFilter(event.target.value, provider))
            }
          />
          <Select
            allowClear
            aria-label={t('aiCatalog.models.filters.type')}
            options={MODEL_TYPES.map((value) => ({ label: value, value }))}
            placeholder={t('aiCatalog.models.filters.type')}
            style={{ minWidth: 130 }}
            value={type || undefined}
            onChange={(value) => patchFilter('type', value as string | undefined)}
          />
          <Select
            allowClear
            aria-label={t('aiCatalog.models.filters.status')}
            placeholder={t('aiCatalog.models.filters.status')}
            style={{ minWidth: 140 }}
            value={status || undefined}
            options={(['draft', 'published', 'archived'] as const).map((value) => ({
              label: t(`aiCatalog.status.${value}` as never),
              value,
            }))}
            onChange={(value) => patchFilter('status', value as string | undefined)}
          />
          <Select
            allowClear
            aria-label={t('aiCatalog.models.filters.enabled')}
            placeholder={t('aiCatalog.models.filters.enabled')}
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
      {modelActions.refreshFailed ? (
        <Alert
          showIcon
          description={t('aiCatalog.refresh.committed.desc')}
          message={t('aiCatalog.refresh.committed.title')}
          type="warning"
          extra={
            <Button
              loading={modelActions.refreshRetrying}
              onClick={() => void modelActions.retryRefresh()}
            >
              {t('aiCatalog.refresh.retry')}
            </Button>
          }
        />
      ) : null}
      <DataTable<AdminAiModelListItem>
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
          filtered ? t('aiCatalog.models.empty.filtered') : t('aiCatalog.models.empty.default')
        }
        onRetry={() => void mutate()}
      />
    </AdminPageTemplate>
  );
});

ModelListPage.displayName = 'AdminAiModelListPage';

export default ModelListPage;
