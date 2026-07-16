'use client';

import { Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import DataTable from '../../primitives/DataTable';
import StatusBadge from '../../primitives/StatusBadge';
import { useFetchAdminAiModels } from '../hooks/useAdminAiCatalog';
import type { AdminAiModelListInput, AdminAiModelListItem } from '../types';

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

const MODEL_TYPES = ['chat', 'embedding', 'image', 'video', 'tts', 'asr'] as const;

const ModelListPage = memo(() => {
  const { t } = useTranslation('admin');
  const [searchParams, setSearchParams] = useSearchParams();
  const enabledParam = searchParams.get('enabled');
  const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;
  const provider = searchParams.get('provider') ?? '';
  const query = searchParams.get('q') ?? '';
  const status = searchParams.get('status') as AdminAiModelListInput['status'];
  const type = searchParams.get('type') ?? '';
  const [searchDraft, setSearchDraft] = useState(query);
  const [providerDraft, setProviderDraft] = useState(provider);
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
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (searchDraft.trim() === query) return;
      patchFilter('q', searchDraft.trim() || undefined);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [patchFilter, query, searchDraft]);

  useEffect(() => {
    if (providerTimerRef.current) window.clearTimeout(providerTimerRef.current);
    providerTimerRef.current = window.setTimeout(() => {
      if (providerDraft.trim() === provider) return;
      patchFilter('provider', providerDraft.trim() || undefined);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (providerTimerRef.current) window.clearTimeout(providerTimerRef.current);
    };
  }, [patchFilter, provider, providerDraft]);

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
    ],
    [t],
  );

  const filtered = Boolean(enabledParam || provider || query || status || type);

  return (
    <AdminPageTemplate
      description={t('aiCatalog.models.desc')}
      title={t('aiCatalog.models.title')}
      toolbar={
        <Flexbox horizontal gap={8} style={{ flexWrap: 'wrap' }}>
          <Input
            allowClear
            aria-label={t('aiCatalog.models.filters.query')}
            placeholder={t('aiCatalog.models.filters.query')}
            style={{ minWidth: 220 }}
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
          <Input
            allowClear
            aria-label={t('aiCatalog.models.filters.provider')}
            placeholder={t('aiCatalog.models.filters.provider')}
            style={{ minWidth: 180 }}
            value={providerDraft}
            onChange={(event) => setProviderDraft(event.target.value)}
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
