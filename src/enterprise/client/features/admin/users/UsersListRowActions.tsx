'use client';

import { Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type { AdminUsersListOutput } from '@/enterprise/client/services/adminUsers';

import {
  openBanUserModal,
  openDeleteUserModal,
  openReplaceRolesModal,
  openUnbanUserModal,
} from './modals/actions';
import { displayUserName } from './utils';

type AdminUserListItem = AdminUsersListOutput['items'][number];

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-wrap: nowrap;
    gap: 4px;
    align-items: center;
  `,
}));

export interface UsersListRowActionsProps {
  actorRoles: readonly { name: string }[];
  authMethod?: AdminReauthAuthMethod;
  canBan: boolean;
  canDelete: boolean;
  canManageRoles: boolean;
  isSelf: boolean;
  onBan: Parameters<typeof openBanUserModal>[0]['onConfirm'];
  onDelete: Parameters<typeof openDeleteUserModal>[0]['onConfirm'];
  /** Opens the slide-in user detail. Only needs USER_READ, which the list already requires. */
  onOpenDetail: () => void;
  onReplaceRoles: Parameters<typeof openReplaceRolesModal>[0]['onConfirm'];
  onUnban: Parameters<typeof openUnbanUserModal>[0]['onConfirm'];
  row: AdminUserListItem;
}

const ActionButton = memo<{
  /** Names the target user, so rows stay distinguishable to a screen reader. */
  ariaLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  disabledTitle?: string;
  label: string;
  onClick: () => void;
}>(({ ariaLabel, danger, disabled, disabledTitle, label, onClick }) => {
  const button = (
    <Button
      aria-label={ariaLabel}
      danger={danger}
      disabled={disabled}
      size="small"
      type="text"
      onClick={onClick}
    >
      {label}
    </Button>
  );

  if (!disabled) return button;

  return (
    <Tooltip title={disabledTitle}>
      <span>{button}</span>
    </Tooltip>
  );
});
ActionButton.displayName = 'UsersListActionButton';

const UsersListRowActions = memo<UsersListRowActionsProps>(
  ({
    actorRoles,
    authMethod,
    canBan,
    canDelete,
    canManageRoles,
    isSelf,
    onBan,
    onDelete,
    onOpenDetail,
    onReplaceRoles,
    onUnban,
    row,
  }) => {
    const { t } = useTranslation('admin');
    const targetLabel = displayUserName(row);
    const selfTitle = t('users.list.selfActionDisabled');

    return (
      <div className={styles.actions}>
        <ActionButton
          ariaLabel={t('users.list.actions.editUser', { name: targetLabel })}
          label={t('users.list.actions.edit')}
          onClick={onOpenDetail}
        />
        {canManageRoles ? (
          <ActionButton
            disabled={isSelf}
            disabledTitle={selfTitle}
            label={t('users.list.actions.roles')}
            onClick={() => {
              openReplaceRolesModal({
                actorRoles,
                authMethod,
                currentRoles: row.roles,
                targetLabel,
                userId: row.id,
                onConfirm: onReplaceRoles,
              });
            }}
          />
        ) : null}
        {canBan ? (
          row.status === 'banned' ? (
            <ActionButton
              disabled={isSelf}
              disabledTitle={selfTitle}
              label={t('users.list.actions.unban')}
              onClick={() => {
                openUnbanUserModal({
                  authMethod,
                  targetLabel,
                  userId: row.id,
                  onConfirm: onUnban,
                });
              }}
            />
          ) : (
            <ActionButton
              danger
              disabled={isSelf}
              disabledTitle={selfTitle}
              label={t('users.list.actions.ban')}
              onClick={() => {
                openBanUserModal({
                  authMethod,
                  targetLabel,
                  userId: row.id,
                  onConfirm: onBan,
                });
              }}
            />
          )
        ) : null}
        {canDelete ? (
          <ActionButton
            danger
            disabled={isSelf}
            disabledTitle={selfTitle}
            label={t('users.list.actions.delete')}
            onClick={() => {
              openDeleteUserModal({
                authMethod,
                targetLabel,
                userId: row.id,
                onConfirm: onDelete,
              });
            }}
          />
        ) : null}
      </div>
    );
  },
);

UsersListRowActions.displayName = 'UsersListRowActions';

export default UsersListRowActions;
