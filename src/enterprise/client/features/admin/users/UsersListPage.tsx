'use client';

import { Avatar, Flexbox, Tag, Text } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { DatePicker } from 'antd';
import { createStaticStyles } from 'antd-style';
import type { Dayjs } from 'dayjs';
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
const DEBOUNCE_MS = 300;

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

export interface UsersListFilters {
  createdFrom?: Date;
  createdTo?: Date;
  query: string;
  role?: string;
  status?: 'active' | 'banned';
}

const emptyFilters = (): UsersListFilters => ({ query: '' });

const UsersListPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();

  const [filters, setFilters] = useState<UsersListFilters>(emptyFilters);
  const [filterBarValues, setFilterBarValues] = useState<AdminFilterValues>(() =>
    createEmptyAdminFilters(),
  );
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [limit, setLimit] = useState(DEFAULT_LIST_LIMIT);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const currentCursor = cursorStack.at(-1) ?? null;

  // Debounce search text only.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery(filterBarValues.query.trim());
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [filterBarValues.query]);

  // Sync debounced query into filters.
  useEffect(() => {
    setFilters((prev) =>
      prev.query === debouncedQuery ? prev : { ...prev, query: debouncedQuery },
    );
  }, [debouncedQuery]);

  // Reset keyset stack when filters or page size change.
  useEffect(() => {
    setCursorStack([]);
  }, [
    filters.query,
    filters.status,
    filters.role,
    filters.createdFrom?.getTime(),
    filters.createdTo?.getTime(),
    limit,
  ]);

  const listFilters = useMemo(
    () => ({
      createdFrom: filters.createdFrom,
      createdTo: filters.createdTo,
      cursor: currentCursor ?? undefined,
      limit,
      query: filters.query || undefined,
      role: filters.role,
      status: filters.status,
    }),
    [currentCursor, filters, limit],
  );

  const { data, error, isLoading, isValidating, mutate } = useFetchAdminUsersList(listFilters);

  const items = data?.items ?? [];
  const nextCursor = data?.nextCursor ?? null;
  const showLoading = isLoading && !data;
  const showError = Boolean(error) && !data;
  const hasFilters = Boolean(
    filters.query || filters.status || filters.role || filters.createdFrom || filters.createdTo,
  );

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
                <Text ellipsis style={{ margin: 0 }} type="secondary">
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

  const handleFilterBarChange = useCallback((next: AdminFilterValues) => {
    setFilterBarValues(next);
    // Clear all extra filters when FilterBar clears
    if (!next.query && Object.values(next).every((v) => !v || !String(v).trim())) {
      setFilters(emptyFilters());
      setDateRange(null);
    }
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
          values={filterBarValues}
          extra={
            <>
              <Select
                allowClear
                aria-label={t('users.list.filters.status')}
                placeholder={t('users.list.filters.status')}
                style={{ minWidth: 140 }}
                value={filters.status}
                options={[
                  { label: t('users.status.active'), value: 'active' },
                  { label: t('users.status.banned'), value: 'banned' },
                ]}
                onChange={(v) =>
                  setFilters((prev) => ({
                    ...prev,
                    status: (v as 'active' | 'banned' | undefined) || undefined,
                  }))
                }
              />
              <Select
                allowClear
                aria-label={t('users.list.filters.role')}
                placeholder={t('users.list.filters.role')}
                style={{ minWidth: 160 }}
                value={filters.role}
                options={ROLE_OPTIONS.map((r) => ({
                  label: t(`users.roles.${r}` as never, { defaultValue: r }),
                  value: r,
                }))}
                onChange={(v) =>
                  setFilters((prev) => ({
                    ...prev,
                    role: (v as string | undefined) || undefined,
                  }))
                }
              />
              <DatePicker.RangePicker
                allowClear
                aria-label={t('users.list.filters.createdRange')}
                value={dateRange}
                onChange={(range) => {
                  setDateRange(range as [Dayjs | null, Dayjs | null] | null);
                  const from = range?.[0]?.startOf('day').toDate();
                  const to = range?.[1]?.endOf('day').toDate();
                  setFilters((prev) => ({
                    ...prev,
                    createdFrom: from,
                    createdTo: to,
                  }));
                }}
              />
            </>
          }
          onChange={handleFilterBarChange}
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
        emptyDescription={hasFilters ? t('users.list.emptyFiltered') : t('users.list.empty')}
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
