'use client';

import { Avatar, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { DatePicker, type TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import dayjs from 'dayjs';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminUsersListOutput } from '@/enterprise/client/services/adminUsers';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable from '../primitives/DataTable';
import FilterBar from '../primitives/FilterBar';
import { type AdminFilterValues, createEmptyAdminFilters } from '../primitives/filterBar.utils';
import StatusBadge from '../primitives/StatusBadge';
import { useAdminUserMutations, useFetchAdminUsersList } from './hooks/useAdminUsers';
import { openCreateUserModal } from './modals/CreateUserModal';
import UserSourceTags from './UserSourceTags';
import { displayUserName, formatAdminDateTime, hasPermission } from './utils';

type AdminUserListItem = AdminUsersListOutput['items'][number];
const DEFAULT_LIST_LIMIT = 50;
const DEBOUNCE_MS = 300;

const styles = createStaticStyles(({ css }) => ({
  filterControl: css`
    flex: 0 0 auto;
  `,
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

/** Atomic list query state: filters + cursor stack + limit (never combine new filters with old cursor). */
interface ListQueryState {
  cursorStack: (string | null)[];
  filters: AdminFilterValues;
  limit: number;
}

const emptyQuery = (): ListQueryState => ({
  cursorStack: [],
  filters: createEmptyAdminFilters(),
  limit: DEFAULT_LIST_LIMIT,
});

const UsersListPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { permissions, authMethod } = useAdminAccess();
  const { createUser } = useAdminUserMutations();

  const canCreate = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_CREATE);

  const [queryState, setQueryState] = useState<ListQueryState>(emptyQuery);
  // Local search draft for debounce — committed query lives in queryState.filters.query
  const [searchDraft, setSearchDraft] = useState('');
  const debounceRef = useRef<number | null>(null);

  const { filters, cursorStack, limit } = queryState;
  const currentCursor = cursorStack.at(-1) ?? null;

  // Debounce search: commit query + reset cursor in the same setState.
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const nextQuery = searchDraft.trim();
      setQueryState((prev) => {
        if (prev.filters.query === nextQuery) return prev;
        return {
          ...prev,
          cursorStack: [],
          filters: { ...prev.filters, query: nextQuery },
        };
      });
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [searchDraft]);

  const listFilters = useMemo(() => {
    const createdFrom = filters.createdFrom ? new Date(filters.createdFrom) : undefined;
    const createdTo = filters.createdTo ? new Date(filters.createdTo) : undefined;
    return {
      createdFrom: createdFrom && !Number.isNaN(createdFrom.getTime()) ? createdFrom : undefined,
      createdTo: createdTo && !Number.isNaN(createdTo.getTime()) ? createdTo : undefined,
      cursor: currentCursor ?? undefined,
      limit,
      query: filters.query || undefined,
      role: filters.role || undefined,
      status: (filters.status as 'active' | 'banned' | undefined) || undefined,
    };
  }, [currentCursor, filters, limit]);

  const { data, error, isLoading, isValidating, mutate } = useFetchAdminUsersList(listFilters);

  const items = data?.items ?? [];
  const nextCursor = data?.nextCursor ?? null;
  const showLoading = isLoading && !data;
  const showError = Boolean(error) && !data;
  const hasFilters = [
    filters.query,
    filters.status,
    filters.role,
    filters.createdFrom,
    filters.createdTo,
  ].some((v) => Boolean(v && String(v).trim()));

  // FilterBar values must include all filter fields so Clear is visible for status/role/date-only.
  const filterBarValues: AdminFilterValues = useMemo(
    () => ({
      ...filters,
      query: searchDraft,
    }),
    [filters, searchDraft],
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
        dataIndex: 'dingtalkTitle',
        key: 'dingtalkTitle',
        title: t('users.list.columns.jobTitle'),
        render: (value: string | null) => (value?.trim() ? value : '—'),
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
        key: 'source',
        title: t('users.list.columns.source'),
        width: 160,
        render: (ids: string[]) => <UserSourceTags providerIds={ids ?? []} />,
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

  const patchFilters = useCallback((patch: Partial<AdminFilterValues>) => {
    setQueryState((prev) => ({
      cursorStack: [],
      filters: { ...prev.filters, ...patch },
      limit: prev.limit,
    }));
  }, []);

  const handleFilterBarChange = useCallback((next: AdminFilterValues) => {
    // Clear button → empty all fields (draft + committed filters + cursor) in one shot.
    // `!hasActiveAdminFiltersHelper` is equivalent to every field being empty (clear payload).
    if (!hasActiveAdminFiltersHelper(next)) {
      setSearchDraft('');
      setQueryState(emptyQuery());
      return;
    }
    // Search keystrokes only update the draft. Committed query + cursor reset happen
    // together in the debounce effect — never clear cursor while keeping the old query.
    setSearchDraft(next.query);
  }, []);

  const goNext = useCallback(() => {
    if (!nextCursor) return;
    setQueryState((prev) => ({
      ...prev,
      cursorStack: [...prev.cursorStack, nextCursor],
    }));
  }, [nextCursor]);

  const goPrevious = useCallback(() => {
    setQueryState((prev) => ({
      ...prev,
      cursorStack: prev.cursorStack.length === 0 ? prev.cursorStack : prev.cursorStack.slice(0, -1),
    }));
  }, []);

  const openCreate = useCallback(() => {
    openCreateUserModal({
      authMethod,
      onSubmit: createUser,
    });
  }, [authMethod, createUser]);

  return (
    <AdminPageTemplate
      description={t('users.list.desc')}
      title={t('users.list.title')}
      actions={
        canCreate ? (
          <Button type="primary" onClick={openCreate}>
            {t('users.list.create')}
          </Button>
        ) : undefined
      }
      toolbar={
        <FilterBar
          searchPlaceholder={t('users.list.searchPlaceholder')}
          values={filterBarValues}
          extra={
            <>
              <div className={styles.filterControl} style={{ width: 150 }}>
                <Select
                  allowClear
                  aria-label={t('users.list.filters.status')}
                  placeholder={t('users.list.filters.status')}
                  style={{ width: '100%' }}
                  value={filters.status || undefined}
                  options={[
                    { label: t('users.status.active'), value: 'active' },
                    { label: t('users.status.banned'), value: 'banned' },
                  ]}
                  onChange={(v) => patchFilters({ status: (v as string | undefined) || '' })}
                />
              </div>
              <div className={styles.filterControl} style={{ width: 160 }}>
                <Select
                  allowClear
                  aria-label={t('users.list.filters.role')}
                  placeholder={t('users.list.filters.role')}
                  style={{ width: '100%' }}
                  value={filters.role || undefined}
                  options={ROLE_OPTIONS.map((r) => ({
                    label: t(`users.roles.${r}` as never, { defaultValue: r }),
                    value: r,
                  }))}
                  onChange={(v) => patchFilters({ role: (v as string | undefined) || '' })}
                />
              </div>
              <DatePicker.RangePicker
                allowClear
                aria-label={t('users.list.filters.createdRange')}
                style={{ width: 250, flex: '0 0 auto' }}
                placeholder={[
                  t('users.list.filters.createdFrom'),
                  t('users.list.filters.createdTo'),
                ]}
                value={[
                  filters.createdFrom ? dayjs(filters.createdFrom) : null,
                  filters.createdTo ? dayjs(filters.createdTo) : null,
                ]}
                onChange={(range) => {
                  const from = range?.[0] ? dayjs(range[0]).startOf('day') : null;
                  const to = range?.[1] ? dayjs(range[1]).endOf('day') : null;
                  setQueryState((prev) => ({
                    cursorStack: [],
                    filters: {
                      ...prev.filters,
                      createdFrom: from ? from.toISOString() : '',
                      createdTo: to ? to.toISOString() : '',
                    },
                    limit: prev.limit,
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
        emptyDescription={hasFilters ? t('users.list.emptyFiltered') : t('users.list.empty')}
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
            setQueryState((prev) => ({
              cursorStack: [],
              filters: prev.filters,
              limit: Math.min(100, Math.max(1, size)),
            }));
          },
          pageSize: limit,
          pageSizeOptions: ['20', '50', '100'],
        }}
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

const hasActiveAdminFiltersHelper = (values: AdminFilterValues) =>
  Object.values(values).some((v) => Boolean(v && String(v).trim()));

UsersListPage.displayName = 'AdminUsersListPage';

export default UsersListPage;
