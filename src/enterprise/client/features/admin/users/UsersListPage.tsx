'use client';

import { Alert, Avatar, Flexbox, SearchBar, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import type { FilterValue } from 'antd/es/table/interface';
import { createStaticStyles } from 'antd-style';
import dayjs from 'dayjs';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminUsersListOutput } from '@/enterprise/client/services/adminUsers';
import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { dateRangeColumnFilter, enumColumnFilter } from '../primitives/columnFilters';
import DataTable from '../primitives/DataTable';
import StatusBadge from '../primitives/StatusBadge';
import { useAdminUserMutations, useFetchAdminUsersList } from './hooks/useAdminUsers';
import {
  type BulkUserTarget,
  openBulkBanModal,
  openBulkDeleteModal,
  openBulkReplaceRolesModal,
  openBulkUnbanModal,
} from './modals/bulkActions';
import { openCreateUserModal } from './modals/CreateUserModal';
import UsersListRowActions from './UsersListRowActions';
import UserSourceTags from './UserSourceTags';
import { displayUserName, formatAdminDateTime, hasPermission } from './utils';

type AdminUserListItem = AdminUsersListOutput['items'][number];
type AdminUserSource = 'local' | 'sso';
type AdminUserStatus = 'active' | 'banned';

const DEFAULT_LIST_LIMIT = 20;
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
  toolbar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    width: 100%;
  `,
  toolbarLeft: css`
    flex: 1 1 240px;
    min-width: 200px;
    max-width: 320px;
  `,
  toolbarRight: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;

    margin-inline-start: auto;
  `,
}));

const ROLE_OPTIONS = Object.values(PLATFORM_SYSTEM_ROLES);

interface ListQueryState {
  createdFrom?: Date;
  createdTo?: Date;
  page: number;
  pageSize: number;
  query: string;
  role?: string;
  source?: AdminUserSource;
  status?: AdminUserStatus;
}

const emptyQuery = (): ListQueryState => ({
  page: 1,
  pageSize: DEFAULT_LIST_LIMIT,
  query: '',
});

const firstFilterValue = (value: FilterValue | null | undefined): string | undefined => {
  if (!value || value.length === 0) return undefined;
  const first = value[0];
  return first == null || first === '' ? undefined : String(first);
};

const parseStatus = (value: FilterValue | null | undefined): AdminUserStatus | undefined => {
  const next = firstFilterValue(value);
  return next === 'active' || next === 'banned' ? next : undefined;
};

const parseSource = (value: FilterValue | null | undefined): AdminUserSource | undefined => {
  const next = firstFilterValue(value);
  return next === 'local' || next === 'sso' ? next : undefined;
};

const UsersListPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { permissions, roles: actorRoles, authMethod } = useAdminAccess();
  const currentUserId = useUserStore(userProfileSelectors.userId);
  const { createUser, banUser, unbanUser, deleteUser, replaceGlobalRoles } =
    useAdminUserMutations();

  const canCreate = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_CREATE);
  const canBan = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_BAN);
  const canDelete = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_DELETE);
  const canManageRoles = hasPermission(permissions, PLATFORM_PERMISSIONS.USER_ROLE_MANAGE);

  const [queryState, setQueryState] = useState<ListQueryState>(emptyQuery);
  const [searchDraft, setSearchDraft] = useState('');
  const [selectedMap, setSelectedMap] = useState<Record<string, AdminUserListItem>>({});
  const debounceRef = useRef<number | null>(null);

  const { createdFrom, createdTo, page, pageSize, query, role, source, status } = queryState;

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const nextQuery = searchDraft.trim();
      setQueryState((prev) => {
        if (prev.query === nextQuery) return prev;
        return { ...prev, page: 1, query: nextQuery };
      });
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [searchDraft]);

  const listFilters = useMemo(
    () => ({
      createdFrom,
      createdTo,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      query: query || undefined,
      role,
      source,
      status,
    }),
    [createdFrom, createdTo, page, pageSize, query, role, source, status],
  );

  const { data, error, isLoading, isValidating, mutate } = useFetchAdminUsersList(listFilters);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  // Jump back when offset is past the current total (deleted last page, stale jumper).
  useEffect(() => {
    if (!data) return;
    const lastPage = Math.max(1, Math.ceil(data.total / pageSize) || 1);
    if (page <= lastPage) return;
    setQueryState((prev) => {
      const nextLast = Math.max(1, Math.ceil(data.total / prev.pageSize) || 1);
      if (prev.page <= nextLast) return prev;
      return { ...prev, page: nextLast };
    });
  }, [data, page, pageSize]);
  const showLoading = isLoading && !data;
  const showError = Boolean(error) && !data;
  const showStaleWarning = Boolean(error) && Boolean(data);
  const hasFilters = Boolean(query || status || role || source || createdFrom || createdTo);

  const selectedRows = useMemo(
    () => Object.values(selectedMap).filter((row) => row.id !== currentUserId),
    [currentUserId, selectedMap],
  );
  const selectedCount = selectedRows.length;

  const toBulkTargets = useCallback(
    (rows: AdminUserListItem[]): BulkUserTarget[] =>
      rows.map((row) => ({
        currentRoles: row.roles,
        id: row.id,
        label: displayUserName(row),
      })),
    [],
  );

  const clearSelection = useCallback(() => {
    setSelectedMap({});
  }, []);

  const createdRange = useMemo<[Date | null, Date | null] | null>(() => {
    if (!createdFrom && !createdTo) return null;
    return [createdFrom ?? null, createdTo ?? null];
  }, [createdFrom, createdTo]);

  const handleCreatedRange = useCallback((value: [Date | null, Date | null] | null) => {
    const from = value?.[0] ? dayjs(value[0]).startOf('day').toDate() : undefined;
    const to = value?.[1] ? dayjs(value[1]).endOf('day').toDate() : undefined;
    setQueryState((prev) => ({
      ...prev,
      createdFrom: from,
      createdTo: to,
      page: 1,
    }));
  }, []);

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
        ...enumColumnFilter({
          options: [
            { label: t('users.status.active'), value: 'active' },
            { label: t('users.status.banned'), value: 'banned' },
          ],
          value: status,
        }),
        render: (value: string) => <StatusBadge status={value} />,
      },
      {
        dataIndex: 'roles',
        key: 'roles',
        title: t('users.list.columns.roles'),
        ...enumColumnFilter({
          options: ROLE_OPTIONS.map((item) => ({
            label: t(`users.roles.${item}` as never, { defaultValue: item }),
            value: item,
          })),
          value: role,
        }),
        render: (roles: string[]) =>
          roles.length ? (
            <Flexbox horizontal gap={4} style={{ flexWrap: 'wrap' }}>
              {roles.map((item) => (
                <Tag key={item} size="small">
                  {t(`users.roles.${item}` as never, { defaultValue: item })}
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
        ...enumColumnFilter({
          options: [
            { label: t('users.source.local'), value: 'local' },
            { label: t('users.source.sso'), value: 'sso' },
          ],
          value: source,
        }),
        render: (ids: string[]) => <UserSourceTags providerIds={ids ?? []} />,
      },
      {
        dataIndex: 'createdAt',
        key: 'createdAt',
        title: t('users.list.columns.createdAt'),
        ...dateRangeColumnFilter({
          value: createdRange,
          onChange: handleCreatedRange,
        }),
        render: (value: Date) => formatAdminDateTime(value),
      },
      {
        dataIndex: 'lastActiveAt',
        key: 'lastActiveAt',
        title: t('users.list.columns.lastActiveAt'),
        render: (value: Date | null) => formatAdminDateTime(value),
      },
      {
        key: 'actions',
        title: t('users.list.columns.actions'),
        width: 220,
        render: (_, row) => (
          <UsersListRowActions
            actorRoles={actorRoles}
            authMethod={authMethod ?? undefined}
            canBan={canBan}
            canDelete={canDelete}
            canManageRoles={canManageRoles}
            isSelf={row.id === currentUserId}
            row={row}
            onBan={banUser}
            onDelete={deleteUser}
            onReplaceRoles={replaceGlobalRoles}
            onUnban={unbanUser}
          />
        ),
      },
    ],
    [
      actorRoles,
      authMethod,
      banUser,
      canBan,
      canDelete,
      canManageRoles,
      createdRange,
      currentUserId,
      deleteUser,
      handleCreatedRange,
      replaceGlobalRoles,
      role,
      source,
      status,
      t,
      unbanUser,
    ],
  );

  const openCreate = useCallback(() => {
    openCreateUserModal({
      authMethod,
      onSubmit: createUser,
    });
  }, [authMethod, createUser]);

  const selfTitle = t('users.list.selfActionDisabled');

  const toolbar = (
    <div className={styles.toolbar}>
      <div className={styles.toolbarLeft}>
        <SearchBar
          allowClear
          placeholder={t('users.list.searchPlaceholder')}
          value={searchDraft}
          variant="filled"
          onInputChange={setSearchDraft}
          onSearch={(value) => {
            setSearchDraft(value);
            setQueryState((prev) => ({ ...prev, page: 1, query: value.trim() }));
          }}
        />
      </div>
      {selectedCount > 0 ? (
        <div className={styles.toolbarRight}>
          <Text type="secondary">{t('users.list.selectedCount', { count: selectedCount })}</Text>
          {canBan ? (
            <>
              <Button
                disabled={!selectedRows.some((row) => row.status === 'active')}
                size="small"
                onClick={() => {
                  openBulkBanModal({
                    actorUserId: currentUserId,
                    authMethod,
                    targets: toBulkTargets(selectedRows.filter((row) => row.status === 'active')),
                    onConfirmEach: banUser,
                    onDone: clearSelection,
                  });
                }}
              >
                {t('users.list.bulk.ban')}
              </Button>
              <Button
                disabled={!selectedRows.some((row) => row.status === 'banned')}
                size="small"
                onClick={() => {
                  openBulkUnbanModal({
                    actorUserId: currentUserId,
                    authMethod,
                    targets: toBulkTargets(selectedRows.filter((row) => row.status === 'banned')),
                    onConfirmEach: unbanUser,
                    onDone: clearSelection,
                  });
                }}
              >
                {t('users.list.bulk.unban')}
              </Button>
            </>
          ) : null}
          {canManageRoles ? (
            <Button
              size="small"
              onClick={() => {
                openBulkReplaceRolesModal({
                  actorRoles,
                  actorUserId: currentUserId,
                  authMethod,
                  targets: toBulkTargets(selectedRows),
                  onConfirmEach: replaceGlobalRoles,
                  onDone: clearSelection,
                });
              }}
            >
              {t('users.list.bulk.roles')}
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              danger
              size="small"
              onClick={() => {
                openBulkDeleteModal({
                  actorUserId: currentUserId,
                  authMethod,
                  targets: toBulkTargets(selectedRows),
                  onConfirmEach: deleteUser,
                  onDone: clearSelection,
                });
              }}
            >
              {t('users.list.bulk.delete')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

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
    >
      {showStaleWarning ? (
        <Alert
          showIcon
          style={{ marginBottom: 12 }}
          type="warning"
          action={
            <Button size="small" onClick={() => void mutate()}>
              {t('primitives.dataTable.retry')}
            </Button>
          }
          message={t('users.stale.refreshFailed', {
            defaultValue: 'Showing cached data — the latest refresh failed.',
          })}
        />
      ) : null}
      <DataTable<AdminUserListItem>
        virtual
        columns={columns}
        dataSource={items}
        emptyDescription={hasFilters ? t('users.list.emptyFiltered') : t('users.list.empty')}
        error={showError}
        loading={showLoading || (isValidating && !data)}
        rowKey="id"
        scroll={{ x: 1180, y: 560 }}
        toolbar={toolbar}
        pagination={{
          current: page,
          pageSize,
          total,
        }}
        rowSelection={{
          getCheckboxProps: (row) => ({
            disabled: row.id === currentUserId,
            title: row.id === currentUserId ? selfTitle : undefined,
          }),
          preserveSelectedRowKeys: true,
          selectedRowKeys: Object.keys(selectedMap),
          onChange: (keys, rows) => {
            setSelectedMap((prev) => {
              const next: Record<string, AdminUserListItem> = {};
              const visible = new Map(rows.map((row) => [row.id, row]));
              for (const key of keys as string[]) {
                if (key === currentUserId) continue;
                const row = visible.get(key) ?? prev[key];
                if (row) next[key] = row;
              }
              return next;
            });
          },
        }}
        onChange={({ filters }) => {
          const nextStatus = parseStatus(filters.status);
          const nextRole = firstFilterValue(filters.roles);
          const nextSource = parseSource(filters.source);
          setQueryState((prev) => {
            const filtersChanged =
              nextStatus !== prev.status || nextRole !== prev.role || nextSource !== prev.source;
            if (
              !filtersChanged &&
              nextStatus === prev.status &&
              nextRole === prev.role &&
              nextSource === prev.source
            ) {
              return prev;
            }
            return {
              ...prev,
              page: filtersChanged ? 1 : prev.page,
              role: nextRole,
              source: nextSource,
              status: nextStatus,
            };
          });
        }}
        onPaginationChange={(nextPage, nextPageSize) => {
          setQueryState((prev) => ({
            ...prev,
            page: nextPage,
            pageSize: nextPageSize,
          }));
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

UsersListPage.displayName = 'AdminUsersListPage';

export default UsersListPage;
