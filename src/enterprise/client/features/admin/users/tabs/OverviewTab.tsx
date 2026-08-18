'use client';

import { Flexbox, Text, Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import { formatAuditReason } from '../../audit/shared/auditReasonCodes';
import StatusBadge from '../../primitives/StatusBadge';
import UserSourceTags from '../UserSourceTags';
import { formatAdminDateTime } from '../utils';
import SecuritySection from './SecuritySection';

/**
 * Reason (i18n key) the change-password button is disabled, or null when it is live.
 *
 * Order matters: the account-shape reason (SSO-only) outranks the actor-shape one
 * (self) so the admin is told the fact that will still be true tomorrow.
 */
export const resolveSetPasswordDisabledReason = (params: {
  hasPassword: boolean;
  /** False when the detail view is stale and high-risk actions are locked. */
  isLive: boolean;
  isSelf: boolean;
}): string | null => {
  if (!params.hasPassword) return 'users.security.password.ssoOnly';
  if (params.isSelf) return 'users.errors.selfAction';
  if (!params.isLive) return 'users.stale.refreshFailed';
  return null;
};

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  `,
  dl: css`
    display: grid;
    grid-template-columns: 160px 1fr;
    gap: 8px 16px;
    margin: 0;

    dt {
      color: ${cssVar.colorTextSecondary};
    }

    dd {
      margin: 0;
    }
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
}));

interface OverviewTabProps {
  canBan: boolean;
  canDelete: boolean;
  /** Actor holds USER_CREDENTIAL_MANAGE — gates the two security actions only. */
  canManageCredentials?: boolean;
  onBan?: () => void;
  onDelete?: () => void;
  /** Undefined when the action is unavailable (stale detail data). */
  onDisableTwoFactor?: () => void;
  /** Undefined when the action is unavailable (stale detail data). */
  onSetPassword?: () => void;
  onUnban?: () => void;
  user: AdminUsersGetOutput;
}

const OverviewTab = memo<OverviewTabProps>(
  ({
    user,
    canBan,
    canDelete,
    canManageCredentials = false,
    onBan,
    onDelete,
    onDisableTwoFactor,
    onSetPassword,
    onUnban,
  }) => {
    const { t } = useTranslation('admin');
    const isBanned = user.status === 'banned';
    // Change password is gated by its own permission, so the block has to appear for an
    // actor who may only manage credentials — not just for ban/delete holders.
    const showActions = canBan || canDelete || canManageCredentials;
    const showBanDelete = !user.isSelf && (canBan || canDelete);
    const setPasswordDisabledReason = resolveSetPasswordDisabledReason({
      hasPassword: user.hasPassword,
      isLive: Boolean(onSetPassword),
      isSelf: user.isSelf,
    });
    const providerIds = useMemo(() => user.providers.map((p) => p.providerId), [user.providers]);

    return (
      <div className={styles.section}>
        <Text as="h3" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
          {t('users.overview.identity')}
        </Text>
        <dl className={styles.dl}>
          <dt>{t('users.overview.email')}</dt>
          <dd>{user.email ?? '—'}</dd>
          <dt>{t('users.overview.username')}</dt>
          <dd>{user.username ?? '—'}</dd>
          <dt>{t('users.overview.fullName')}</dt>
          <dd>{user.fullName ?? '—'}</dd>
          <dt>{t('users.overview.jobTitle')}</dt>
          <dd>{user.dingtalkTitle?.trim() ? user.dingtalkTitle : '—'}</dd>
          <dt>{t('users.overview.status')}</dt>
          <dd>
            <StatusBadge status={user.status} />
          </dd>
          <dt>{t('users.overview.source')}</dt>
          <dd>
            <UserSourceTags providerIds={providerIds} />
          </dd>
          {user.banned ? (
            <>
              <dt>{t('users.overview.banReason')}</dt>
              <dd>
                {formatAuditReason(user.banReason, (key, options) =>
                  String(t(key as never, options as never)),
                ) ?? '—'}
              </dd>
              <dt>{t('users.overview.banExpires')}</dt>
              <dd>{formatAdminDateTime(user.banExpires)}</dd>
            </>
          ) : null}
          <dt>{t('users.overview.createdAt')}</dt>
          <dd>{formatAdminDateTime(user.createdAt)}</dd>
          <dt>{t('users.overview.lastActiveAt')}</dt>
          <dd>{formatAdminDateTime(user.lastActiveAt)}</dd>
        </dl>

        <Text as="h3" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
          {t('users.overview.providers')}
        </Text>
        {user.providers.length === 0 ? (
          <Text type="secondary">{t('users.overview.noProviders')}</Text>
        ) : (
          <Flexbox gap={8}>
            {user.providers.map((p) => (
              <Text key={`${p.providerId}-${p.createdAt?.toString() ?? ''}`}>
                {t(`users.providers.${p.providerId}` as never, { defaultValue: p.providerId })}
                {p.accountIdHint ? ` (${p.accountIdHint})` : ''}
                {p.createdAt ? ` · ${formatAdminDateTime(p.createdAt)}` : ''}
              </Text>
            ))}
          </Flexbox>
        )}

        <SecuritySection
          canManageCredentials={canManageCredentials}
          user={user}
          onDisableTwoFactor={onDisableTwoFactor}
        />

        {showActions ? (
          <>
            <Text as="h3" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
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
            {user.isSelf && (canBan || canDelete) ? (
              <Text type="secondary">{t('users.overview.selfActionsHidden')}</Text>
            ) : null}
          </>
        ) : null}
      </div>
    );
  },
);

OverviewTab.displayName = 'AdminUserOverviewTab';

export default OverviewTab;
