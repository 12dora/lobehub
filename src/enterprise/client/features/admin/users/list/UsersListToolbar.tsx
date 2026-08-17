'use client';

import { SearchBar, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import type { useAdminUserMutations } from '../hooks/useAdminUsers';
import {
  openBulkBanModal,
  openBulkDeleteModal,
  openBulkReplaceRolesModal,
  openBulkUnbanModal,
} from '../modals/bulkActions';
import type { AdminUserListItem } from './useUsersListSelection';

const styles = createStaticStyles(({ css }) => ({
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

export interface UsersListToolbarProps {
  actorRoles: readonly { name: string }[];
  authMethod?: AdminReauthAuthMethod | null;
  canBan: boolean;
  canDelete: boolean;
  canManageRoles: boolean;
  currentUserId?: string;
  mutations: Pick<
    ReturnType<typeof useAdminUserMutations>,
    'banUser' | 'deleteUser' | 'replaceGlobalRoles' | 'unbanUser'
  >;
  onCleared: () => void;
  onSearch: (value: string) => void;
  searchDraft: string;
  selectedRows: AdminUserListItem[];
  setSearchDraft: (value: string) => void;
  toBulkTargets: (
    rows: AdminUserListItem[],
  ) => { currentRoles?: readonly string[]; id: string; label: string }[];
}

export const UsersListToolbar = ({
  actorRoles,
  authMethod,
  canBan,
  canDelete,
  canManageRoles,
  currentUserId,
  mutations,
  onCleared,
  onSearch,
  searchDraft,
  selectedRows,
  setSearchDraft,
  toBulkTargets,
}: UsersListToolbarProps) => {
  const { t } = useTranslation('admin');
  const selectedCount = selectedRows.length;

  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarLeft}>
        <SearchBar
          allowClear
          placeholder={t('users.list.searchPlaceholder')}
          value={searchDraft}
          variant="filled"
          onInputChange={setSearchDraft}
          onSearch={onSearch}
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
                    onConfirmEach: mutations.banUser,
                    onDone: onCleared,
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
                    onConfirmEach: mutations.unbanUser,
                    onDone: onCleared,
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
                  onConfirmEach: mutations.replaceGlobalRoles,
                  onDone: onCleared,
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
                  onConfirmEach: mutations.deleteUser,
                  onDone: onCleared,
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
};
