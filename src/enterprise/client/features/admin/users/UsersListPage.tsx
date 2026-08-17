'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable from '../primitives/DataTable';
import { useAdminUserMutations } from './hooks/useAdminUsers';
import { buildUsersListColumns } from './list/usersListColumns';
import { UsersListToolbar } from './list/UsersListToolbar';
import { useUsersListQuery } from './list/useUsersListQuery';
import type { AdminUserListItem } from './list/useUsersListSelection';
import { useUsersListSelection } from './list/useUsersListSelection';
import { openCreateUserModal } from './modals/CreateUserModal';
import { hasPermission } from './utils';

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

  const {
    createdRange,
    data,
    error,
    handleCreatedRange,
    handlePaginationChange,
    handleTableChange,
    isLoading,
    isValidating,
    mutate,
    queryState,
    searchDraft,
    setQueryState,
    setSearchDraft,
  } = useUsersListQuery();

  const { createdFrom, createdTo, page, pageSize, query, role, source, status } = queryState;

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const showLoading = isLoading && !data;
  const showError = Boolean(error) && !data;
  const showStaleWarning = Boolean(error) && Boolean(data);
  const hasFilters = Boolean(query || status || role || source || createdFrom || createdTo);

  const selfTitle = t('users.list.selfActionDisabled');
  const { clearSelection, rowSelection, selectedRows, toBulkTargets } = useUsersListSelection({
    currentUserId,
    selfActionDisabledTitle: selfTitle,
  });

  const mutations = useMemo(
    () => ({ banUser, deleteUser, replaceGlobalRoles, unbanUser }),
    [banUser, deleteUser, replaceGlobalRoles, unbanUser],
  );

  const columns = useMemo(
    () =>
      buildUsersListColumns({
        actorRoles,
        authMethod,
        canBan,
        canDelete,
        canManageRoles,
        createdRange,
        currentUserId,
        handleCreatedRange,
        mutations,
        role,
        source,
        status,
        t,
      }),
    [
      actorRoles,
      authMethod,
      canBan,
      canDelete,
      canManageRoles,
      createdRange,
      currentUserId,
      handleCreatedRange,
      mutations,
      role,
      source,
      status,
      t,
    ],
  );

  const openCreate = useCallback(() => {
    openCreateUserModal({
      authMethod,
      onSubmit: createUser,
    });
  }, [authMethod, createUser]);

  const handleSearch = useCallback(
    (value: string) => {
      setSearchDraft(value);
      setQueryState((prev) => ({ ...prev, page: 1, query: value.trim() }));
    },
    [setQueryState, setSearchDraft],
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
        rowSelection={rowSelection}
        scroll={{ x: 1180, y: 560 }}
        pagination={{
          current: page,
          pageSize,
          total,
        }}
        toolbar={
          <UsersListToolbar
            actorRoles={actorRoles}
            authMethod={authMethod}
            canBan={canBan}
            canDelete={canDelete}
            canManageRoles={canManageRoles}
            currentUserId={currentUserId}
            mutations={mutations}
            searchDraft={searchDraft}
            selectedRows={selectedRows}
            setSearchDraft={setSearchDraft}
            toBulkTargets={toBulkTargets}
            onCleared={clearSelection}
            onSearch={handleSearch}
          />
        }
        onChange={handleTableChange}
        onPaginationChange={handlePaginationChange}
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
