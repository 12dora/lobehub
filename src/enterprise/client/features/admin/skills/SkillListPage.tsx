'use client';

import { Alert, Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Button, Select, toast } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminSkillsService } from '@/enterprise/client/services/adminSkills';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable from '../primitives/DataTable';
import StatusBadge from '../primitives/StatusBadge';
import { deriveSkillPermissions } from './controller';
import { refreshAdminSkillLists, useFetchAdminSkills } from './hooks/useAdminSkills';
import { openCreateSkillModal } from './openCreateSkillModal';
import type { AdminSkillListInput, AdminSkillListItem } from './types';

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

const valueFrom = <Value extends string>(
  value: string | null,
  allowed: readonly Value[],
): Value | undefined => (allowed.includes(value as Value) ? (value as Value) : undefined);

const SkillListPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { authMethod, permissions } = useAdminAccess();
  const { canCreate, canRead } = deriveSkillPermissions(permissions);
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const normalizedQuery = query.trim();
  const status = valueFrom(searchParams.get('status'), ['draft', 'published', 'archived']);
  const source = valueFrom(searchParams.get('source'), ['builtin', 'uploaded']);
  const distribution = valueFrom(searchParams.get('distribution'), [
    'mandatory',
    'default',
    'optional',
  ]);
  const enabledParam = searchParams.get('enabled');
  const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;
  const filterFingerprint = JSON.stringify([
    normalizedQuery,
    status ?? '',
    source ?? '',
    distribution ?? '',
    enabledParam === 'true' || enabledParam === 'false' ? enabledParam : '',
  ]);
  const [queryDraft, setQueryDraft] = useState(query);
  const [committedCreateId, setCommittedCreateId] = useState<string | null>(null);
  const [createRefreshFailed, setCreateRefreshFailed] = useState(false);
  const [createRefreshRetrying, setCreateRefreshRetrying] = useState(false);
  const [cursorState, setCursorState] = useState<{
    fingerprint: string;
    stack: (string | null)[];
  }>(() => ({ fingerprint: filterFingerprint, stack: [] }));
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const searchTimerRef = useRef<number | null>(null);
  const cursorStack = cursorState.fingerprint === filterFingerprint ? cursorState.stack : [];
  const cursor = cursorStack.at(-1) ?? null;
  const input = useMemo<AdminSkillListInput>(
    () => ({
      cursor: cursor ?? undefined,
      distribution,
      enabled,
      limit,
      query: normalizedQuery || undefined,
      source,
      status,
    }),
    [cursor, distribution, enabled, limit, normalizedQuery, source, status],
  );
  const { data, error, isLoading, mutate } = useFetchAdminSkills(input, canRead);

  const patchFilter = useCallback(
    (key: 'distribution' | 'enabled' | 'q' | 'source' | 'status', value?: string) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set(key, value);
      else next.delete(key);
      setSearchParams(next, { replace: true });
      setCursorState({ fingerprint: '', stack: [] });
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => setQueryDraft(query), [query]);
  useEffect(() => {
    if (cursorState.fingerprint === filterFingerprint) return;
    setCursorState({ fingerprint: filterFingerprint, stack: [] });
  }, [cursorState.fingerprint, filterFingerprint]);
  useEffect(() => {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    if (queryDraft === query) return;
    searchTimerRef.current = window.setTimeout(
      () => patchFilter('q', queryDraft.trim() || undefined),
      SEARCH_DEBOUNCE_MS,
    );
    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    };
  }, [patchFilter, query, queryDraft]);

  const columns = useMemo<TableColumnsType<AdminSkillListItem>>(
    () => [
      {
        key: 'skill',
        title: t('skillCatalog.list.columns.skill'),
        render: (_, item) => (
          <div className={styles.identity}>
            <Text ellipsis strong>
              {item.displayName}
            </Text>
            <Text code ellipsis type="secondary">
              {item.skillKey}
            </Text>
          </div>
        ),
      },
      {
        dataIndex: 'status',
        key: 'status',
        title: t('skillCatalog.list.columns.status'),
        render: (value: string) => <StatusBadge status={value} />,
      },
      {
        dataIndex: 'source',
        key: 'source',
        title: t('skillCatalog.list.columns.source'),
        render: (value: AdminSkillListItem['source']) => t(`skillCatalog.source.${value}` as never),
      },
      {
        dataIndex: 'distribution',
        key: 'distribution',
        title: t('skillCatalog.list.columns.distribution'),
        render: (value: AdminSkillListItem['distribution']) => (
          <Tag>{t(`skillCatalog.distribution.${value}` as never)}</Tag>
        ),
      },
      {
        dataIndex: 'enabled',
        key: 'enabled',
        title: t('skillCatalog.list.columns.enabled'),
        render: (value: boolean) => (
          <Tag color={value ? 'success' : 'default'}>
            {t(`skillCatalog.boolean.${value}` as never)}
          </Tag>
        ),
      },
      {
        dataIndex: 'revision',
        key: 'revision',
        title: t('skillCatalog.list.columns.revision'),
      },
    ],
    [t],
  );

  const filtered = Boolean(
    normalizedQuery ||
    status ||
    source ||
    distribution ||
    enabledParam === 'true' ||
    enabledParam === 'false',
  );

  const retryCreatedRefresh = async () => {
    if (!committedCreateId) return;
    setCreateRefreshRetrying(true);
    try {
      await refreshAdminSkillLists();
      const id = committedCreateId;
      setCommittedCreateId(null);
      setCreateRefreshFailed(false);
      navigate(`/admin/skills/${encodeURIComponent(id)}`);
    } catch {
      setCreateRefreshFailed(true);
    } finally {
      setCreateRefreshRetrying(false);
    }
  };

  return (
    <AdminPageTemplate
      description={t('skillCatalog.list.desc')}
      title={t('skillCatalog.list.title')}
      actions={
        canCreate ? (
          <Button
            disabled={Boolean(committedCreateId)}
            type="primary"
            onClick={() =>
              openCreateSkillModal({
                authMethod: authMethod ?? undefined,
                onSubmit: async (input) => {
                  const created = await adminSkillsService.create(input);
                  setCommittedCreateId(created.draft.id);
                  toast.success(t('skillCatalog.toast.created'));
                  try {
                    await refreshAdminSkillLists();
                    setCommittedCreateId(null);
                    setCreateRefreshFailed(false);
                    navigate(`/admin/skills/${encodeURIComponent(created.draft.id)}`);
                  } catch {
                    setCreateRefreshFailed(true);
                  }
                },
              })
            }
          >
            {t('skillCatalog.create.submit')}
          </Button>
        ) : null
      }
      toolbar={
        <Flexbox horizontal gap={8} wrap="wrap">
          <Input
            allowClear
            aria-label={t('skillCatalog.list.filters.query')}
            placeholder={t('skillCatalog.list.filters.query')}
            style={{ minWidth: 240 }}
            value={queryDraft}
            onChange={(event) => setQueryDraft(event.target.value)}
          />
          <Select
            allowClear
            aria-label={t('skillCatalog.list.filters.status')}
            placeholder={t('skillCatalog.list.filters.status')}
            style={{ minWidth: 140 }}
            value={status}
            options={(['draft', 'published', 'archived'] as const).map((value) => ({
              label: t(`skillCatalog.status.${value}` as never),
              value,
            }))}
            onChange={(value) => patchFilter('status', value as string | undefined)}
          />
          <Select
            allowClear
            aria-label={t('skillCatalog.list.filters.source')}
            placeholder={t('skillCatalog.list.filters.source')}
            style={{ minWidth: 140 }}
            value={source}
            options={(['builtin', 'uploaded'] as const).map((value) => ({
              label: t(`skillCatalog.source.${value}` as never),
              value,
            }))}
            onChange={(value) => patchFilter('source', value as string | undefined)}
          />
          <Select
            allowClear
            aria-label={t('skillCatalog.list.filters.distribution')}
            placeholder={t('skillCatalog.list.filters.distribution')}
            style={{ minWidth: 150 }}
            value={distribution}
            options={(['mandatory', 'default', 'optional'] as const).map((value) => ({
              label: t(`skillCatalog.distribution.${value}` as never),
              value,
            }))}
            onChange={(value) => patchFilter('distribution', value as string | undefined)}
          />
          <Select
            allowClear
            aria-label={t('skillCatalog.list.filters.enabled')}
            placeholder={t('skillCatalog.list.filters.enabled')}
            style={{ minWidth: 130 }}
            value={enabledParam === 'true' || enabledParam === 'false' ? enabledParam : undefined}
            options={[
              { label: t('skillCatalog.boolean.true'), value: 'true' },
              { label: t('skillCatalog.boolean.false'), value: 'false' },
            ]}
            onChange={(value) => patchFilter('enabled', value as string | undefined)}
          />
        </Flexbox>
      }
    >
      {createRefreshFailed ? (
        <Alert
          showIcon
          message={t('skillCatalog.create.refreshFailed')}
          type="warning"
          extra={
            <Button loading={createRefreshRetrying} onClick={() => void retryCreatedRefresh()}>
              {t('skillCatalog.actions.retry')}
            </Button>
          }
        />
      ) : null}
      <DataTable<AdminSkillListItem>
        columns={columns}
        dataSource={data?.items}
        error={Boolean(error) && !data}
        loading={isLoading && !data}
        pagination={false}
        rowKey="id"
        cursorPagination={{
          hasNext: Boolean(data?.nextCursor) && !error,
          hasPrevious: cursorStack.length > 0,
          pageSize: limit,
          onNext: () => {
            if (!data?.nextCursor) return;
            setCursorState({
              fingerprint: filterFingerprint,
              stack: [...cursorStack, data.nextCursor],
            });
          },
          onPageSizeChange: (pageSize) => {
            setLimit(pageSize);
            setCursorState({ fingerprint: filterFingerprint, stack: [] });
          },
          onPrevious: () =>
            setCursorState({ fingerprint: filterFingerprint, stack: cursorStack.slice(0, -1) }),
        }}
        emptyDescription={
          filtered ? t('skillCatalog.list.empty.filtered') : t('skillCatalog.list.empty.default')
        }
        onRetry={() => void mutate()}
        onRowActivate={(item) => navigate(`/admin/skills/${encodeURIComponent(item.id)}`)}
      />
      {error && data ? (
        <Alert
          showIcon
          extra={<Button onClick={() => void mutate()}>{t('skillCatalog.actions.retry')}</Button>}
          message={t('skillCatalog.list.error.page')}
          type="error"
        />
      ) : null}
    </AdminPageTemplate>
  );
});

SkillListPage.displayName = 'AdminSkillListPage';

export default SkillListPage;
