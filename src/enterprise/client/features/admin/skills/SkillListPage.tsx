'use client';

import { Alert, Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import type { FilterValue } from 'antd/es/table/interface';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminSkillsService } from '@/enterprise/client/services/adminSkills';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { enumColumnFilter } from '../primitives/columnFilters';
import DataTable, { type AdminTableChangeMeta } from '../primitives/DataTable';
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
  // Admin list is DB-backed only (all production creates use source:'uploaded').
  // Built-in bundled skills are merged at runtime by the read service, not this list.
  const source = valueFrom(searchParams.get('source'), ['uploaded'] as const);
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
        ...enumColumnFilter({
          options: (['draft', 'published', 'archived'] as const).map((value) => ({
            label: t(`skillCatalog.status.${value}` as never),
            value,
          })),
          value: status,
        }),
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
        ...enumColumnFilter({
          options: (['mandatory', 'default', 'optional'] as const).map((value) => ({
            label: t(`skillCatalog.distribution.${value}` as never),
            value,
          })),
          value: distribution,
        }),
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
        ...enumColumnFilter({
          options: [
            { label: t('skillCatalog.boolean.true'), value: 'true' },
            { label: t('skillCatalog.boolean.false'), value: 'false' },
          ],
          value: enabledParam === 'true' || enabledParam === 'false' ? enabledParam : undefined,
        }),
      },
      {
        dataIndex: 'revision',
        key: 'revision',
        title: t('skillCatalog.list.columns.revision'),
      },
    ],
    [distribution, enabledParam, status, t],
  );

  const handleTableChange = useCallback(
    ({ filters }: AdminTableChangeMeta) => {
      const next = new URLSearchParams(searchParams);
      let changed = false;
      const assign = (key: 'distribution' | 'enabled' | 'status') => {
        if (!(key in filters)) return;
        const value = firstFilterValue(filters[key]);
        const current = next.get(key) ?? undefined;
        if (value === current) return;
        if (value) next.set(key, value);
        else next.delete(key);
        changed = true;
      };
      assign('status');
      assign('distribution');
      assign('enabled');
      if (!changed) return;
      setSearchParams(next, { replace: true });
      setCursorState({ fingerprint: '', stack: [] });
    },
    [searchParams, setSearchParams],
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
          hasNext: Boolean(data?.nextCursor) && !error && !isLoading,
          hasPrevious: cursorStack.length > 0 && !isLoading,
          pageSize: limit,
          onNext: () => {
            if (!data?.nextCursor || isLoading) return;
            // Idempotent: ignore double-click while the next cursor is already active.
            if (cursorStack.at(-1) === data.nextCursor) return;
            setCursorState({
              fingerprint: filterFingerprint,
              stack: [...cursorStack, data.nextCursor],
            });
          },
          onPageSizeChange: (pageSize) => {
            setLimit(pageSize);
            setCursorState({ fingerprint: filterFingerprint, stack: [] });
          },
          onPrevious: () => {
            if (isLoading) return;
            setCursorState({ fingerprint: filterFingerprint, stack: cursorStack.slice(0, -1) });
          },
        }}
        emptyDescription={
          filtered ? t('skillCatalog.list.empty.filtered') : t('skillCatalog.list.empty.default')
        }
        toolbar={
          <Flexbox horizontal className={styles.toolbar} data-testid="skill-list-toolbar">
            <div className={styles.toolbarSearch}>
              <Input
                allowClear
                aria-label={t('skillCatalog.list.filters.query')}
                placeholder={t('skillCatalog.list.filters.query')}
                style={{ width: '100%' }}
                value={queryDraft}
                onChange={(event) => setQueryDraft(event.target.value)}
              />
            </div>
          </Flexbox>
        }
        onChange={handleTableChange}
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
