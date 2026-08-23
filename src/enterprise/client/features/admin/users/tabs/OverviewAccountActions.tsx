'use client';

import { Text, Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { detailStyles as styles } from './detailStyles';
import { resolveSetPasswordDisabledReason } from './resolveSetPasswordDisabledReason';

interface OverviewAccountActionsProps {
  canBan: boolean;
  canDelete: boolean;
  /** Actor holds USER_CREDENTIAL_MANAGE — gates the two security actions only. */
  canManageCredentials: boolean;
  hasPassword: boolean;
  isBanned: boolean;
  isSelf: boolean;
  onBan?: () => void;
  onDelete?: () => void;
  onSetPassword?: () => void;
  onUnban?: () => void;
}

/** Ban / unban / delete plus change-password — the write side of the overview tab. */
export const OverviewAccountActions = memo<OverviewAccountActionsProps>(
  ({
    canBan,
    canDelete,
    canManageCredentials,
    hasPassword,
    isBanned,
    isSelf,
    onBan,
    onDelete,
    onSetPassword,
    onUnban,
  }) => {
    const { t } = useTranslation('admin');
    // Change password is gated by its own permission, so the block has to appear for an
    // actor who may only manage credentials — not just for ban/delete holders.
    const showActions = canBan || canDelete || canManageCredentials;
    const showBanDelete = !isSelf && (canBan || canDelete);
    const setPasswordDisabledReason = resolveSetPasswordDisabledReason({
      hasPassword,
      isLive: Boolean(onSetPassword),
      isSelf,
    });

    if (!showActions) return null;

    return (
      <section className={styles.section}>
        <Text as="h3" className={styles.sectionTitle}>
          {t('users.overview.accountActions')}
        </Text>
        {canManageCredentials || showBanDelete ? (
          <div className={styles.actions}>
            {/* Least destructive first: changing a password recovers an account,
                banning and deleting take one away. */}
            {canManageCredentials ? (
              <Tooltip
                title={setPasswordDisabledReason ? t(setPasswordDisabledReason as never) : ''}
              >
                {/* Wrapper span: a disabled button swallows the events the tooltip needs. */}
                <span>
                  <Button
                    disabled={Boolean(setPasswordDisabledReason)}
                    size="small"
                    onClick={onSetPassword}
                  >
                    {t('users.security.password.action')}
                  </Button>
                </span>
              </Tooltip>
            ) : null}
            {showBanDelete && canBan && !isBanned && onBan ? (
              <Button danger size="small" onClick={onBan}>
                {t('users.actions.ban')}
              </Button>
            ) : null}
            {showBanDelete && canBan && isBanned && onUnban ? (
              <Button size="small" onClick={onUnban}>
                {t('users.actions.unban')}
              </Button>
            ) : null}
            {showBanDelete && canDelete && onDelete ? (
              <Button danger size="small" onClick={onDelete}>
                {t('users.actions.delete')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {/* Ban/delete are hidden on your own account; change password stays, disabled. */}
        {isSelf && (canBan || canDelete) ? (
          <Text style={{ fontSize: 12 }} type="secondary">
            {t('users.overview.selfActionsHidden')}
          </Text>
        ) : null}
      </section>
    );
  },
);

OverviewAccountActions.displayName = 'AdminUserOverviewAccountActions';
