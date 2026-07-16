'use client';

import { Avatar, Flexbox, Tag, Text } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import type { AdminUsersListOutput } from '@/enterprise/client/services/adminUsers';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable from '../primitives/DataTable';
import FilterBar from '../primitives/FilterBar';
import { type AdminFilterValues, createEmptyAdminFilters } from '../primitives/filterBar.utils';
import StatusBadge from '../primitives/StatusBadge';
import { useFetchAdminUsersList } from './hooks/useAdminUsers';
import { displayUserName, formatAdminDateTime } from './utils';

type AdminUserListItem = AdminUsersListOutput['items'][number];
const DEFAULT_LIST_LIMIT = 50;

const styles = createStaticStyles(({ css }) => ({
  identity: css`
    display: flex;
    gap: 10px;
    align-items: center;
    min-width: 0;
  `,
  identityText: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
}));

const ROLE_OPTIONS = Object.values(PLATFORM_SYSTEM_ROLES);

const DEBOUNCE_MS = 300;

const UsersListPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();

  const [filterValues, setFilterValues] = useState<AdminFilterValues>(() =>
    createEmptyAdminFilters(),
  );
  const [status, setStatus] = useState<'active' | 'banned' | undefined>();
  const [role, setRole] = useState<string | undefined>();
  const [limit, setLimit] = useState(DEFAULT_LIST_LIMIT);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  /** Stack of cursors used to reach the current page (empty = first page). */
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const currentCursor = cursorStack.at(-1) ?? null;

  // Debounce search only — status/role apply immediately.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery(filterValues.query.trim());
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [filterValues.query]);

  // Reset keyset stack when filters or page size change.
  useEffect(() => {
    setCursorStack([]);
  }, [debouncedQuery, status, role, limit]);

  const listFilters = useMemo(
    () => ({
      cursor: currentCursor ?? undefined,
      limit,
      query: debouncedQuery || undefined,
      role,
      status,
    }),
    [currentCursor, debouncedQuery, limit, role, status],
  );

  const { data, error, isLoading, isValidating, mutate } = useFetchAdminUsersList(listFilters);

  const items = data?.items ?? [];
  const nextCursor = data?.nextCursor ?? null;
  // Show loading on first settle only; keep rows during background revalidate.
  const showLoading = isLoading && !data;
  const showError = Boolean(error) && !data;

  const columns: TableColumnsType<AdminUserListItem> = useMemo(
    () => [
      {
        key: 'identity',
        title: t('users.list.columns.identity'),
        render: (_, row) => (
          <div className={styles.identity}>
            <Avatar avatar={row.avatar ?? undefined} size={32} />
            <div className={styles.identityText}>
              <Text ellipsis style={{ fontWeight: 600, margin: 0 }}>
                {displayUserName(row)}
              </Text>
              {row.username ? (
                <Text ellipsis style={{ fontSize: 12, margin: 0 }} type="secondary">
                  @{row.username}
                </Text>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        dataIndex: 'email',
        key: 'email',
        title: t('users.list.columns.email'),
        render: (value: string | null) => value ?? '—',
      },
      {
        dataIndex: 'status',
        key: 'status',
        title: t('users.list.columns.status'),
        render: (value: string) => <StatusBadge status={value} />,
      },
      {
        dataIndex: 'roles',
        key: 'roles',
        title: t('users.list.columns.roles'),
        render: (roles: string[]) =>
          roles.length ? (
            <Flexbox horizontal gap={4} style={{ flexWrap: 'wrap' }}>
              {roles.map((r) => (
                <Tag key={r} size="small">
                  {t(`users.roles.${r}` as never, { defaultValue: r })}
                </Tag>
              ))}
            </Flexbox>
          ) : (
            '—'
          ),
      },
      {
        dataIndex: 'providerIds',
        key: 'providers',
        title: t('users.list.columns.providers'),
        render: (ids: string[]) =>
          ids.length
            ? ids.map((id) => t(`users.providers.${id}` as never, { defaultValue: id })).join(', ')
            : '—',
      },
      {
        dataIndex: 'createdAt',
        key: 'createdAt',
        title: t('users.list.columns.createdAt'),
        render: (v: Date) => formatAdminDateTime(v),
      },
      {
        dataIndex: 'lastActiveAt',
        key: 'lastActiveAt',
        title: t('users.list.columns.lastActiveAt'),
        render: (v: Date | null) => formatAdminDateTime(v),
      },
    ],
    [t],
  );

  const handleFiltersChange = useCallback((next: AdminFilterValues) => {
    setFilterValues(next);
  }, []);

  const goNext = useCallback(() => {
    if (!nextCursor) return;
    setCursorStack((stack) => [...stack, nextCursor]);
  }, [nextCursor]);

  const goPrevious = useCallback(() => {
    setCursorStack((stack) => (stack.length === 0 ? stack : stack.slice(0, -1)));
  }, []);

  return (
    <AdminPageTemplate
      description={t('users.list.desc')}
      title={t('users.list.title')}
      toolbar={
        <FilterBar
          searchPlaceholder={t('users.list.searchPlaceholder')}
          values={filterValues}
          extra={
            <>
              <Select
                allowClear
                aria-label={t('users.list.filters.status')}
                placeholder={t('users.list.filters.status')}
                style={{ minWidth: 140 }}
                value={status}
                options={[
                  { label: t('users.status.active'), value: 'active' },
                  { label: t('users.status.banned'), value: 'banned' },
                ]}
                onChange={(v) => setStatus(v as 'active' | 'banned' | undefined)}
              />
              <Select
                allowClear
                aria-label={t('users.list.filters.role')}
                placeholder={t('users.list.filters.role')}
                style={{ minWidth: 160 }}
                value={role}
                options={ROLE_OPTIONS.map((r) => ({
                  label: t(`users.roles.${r}` as never, { defaultValue: r }),
                  value: r,
                }))}
                onChange={(v) => setRole(v as string | undefined)}
              />
            </>
          }
          onChange={handleFiltersChange}
        />
      }
    >
      <DataTable<AdminUserListItem>
        virtual
        columns={columns}
        dataSource={items}
        error={showError}
        loading={showLoading || (isValidating && !data)}
        pagination={false}
        rowKey="id"
        scroll={{ x: 960, y: 560 }}
        cursorPagination={{
          hasNext: Boolean(nextCursor),
          hasPrevious: cursorStack.length > 0,
          onNext: goNext,
          onPrevious: goPrevious,
          onPageSizeChange: (size) => {
            setLimit(Math.min(100, Math.max(1, size)));
          },
          pageSize: limit,
          pageSizeOptions: ['20', '50', '100'],
        }}
        emptyDescription={
          debouncedQuery || status || role ? t('users.list.emptyFiltered') : t('users.list.empty')
        }
        onRetry={() => {
          void mutate();
        }}
        onRowActivate={(row) => {
          navigate(`/admin/users/${row.id}`);
        }}
      />
    </AdminPageTemplate>
  );
});

UsersListPage.displayName = 'AdminUsersListPage';

export default UsersListPage;
