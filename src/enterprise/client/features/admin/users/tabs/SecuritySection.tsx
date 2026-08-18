'use client';

import { Text, Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import {
  hasRecoverableCredentials,
  resolveCredentialRecoveryCopy,
  resolveCredentialRecoveryVariant,
} from '../credentialRecovery';

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

export interface SecuritySectionProps {
  /** Actor holds USER_CREDENTIAL_MANAGE. Facts stay visible without it. */
  canManageCredentials: boolean;
  /**
   * Opens the credential-recovery modal (clear TOTP and/or passkeys).
   * Undefined when the action is unavailable (stale detail data).
   */
  onDisableTwoFactor?: () => void;
  /** Undefined when the action is unavailable (stale detail data). */
  onSetPassword?: () => void;
  user: AdminUsersGetOutput;
}

/**
 * Reason (i18n key) the change-password button is disabled, or null when it is live.
 *
 * Order matters: the account-shape reason (SSO-only) outranks the actor-shape one
 * (self) so the admin is told the fact that will still be true tomorrow.
 */
export const resolveSetPasswordDisabledReason = (params: {
  hasPassword: boolean;
  isSelf: boolean;
  /** False when the detail view is stale and high-risk actions are locked. */
  isLive: boolean;
}): string | null => {
  if (!params.hasPassword) return 'users.security.password.ssoOnly';
  if (params.isSelf) return 'users.errors.selfAction';
  if (!params.isLive) return 'users.stale.refreshFailed';
  return null;
};

/** Reason the credential-recovery button is disabled, or null when it is live. */
export const resolveDisableTwoFactorDisabledReason = (params: {
  isLive: boolean;
}): string | null => (params.isLive ? null : 'users.stale.refreshFailed');

/**
 * Security facts + the two credential-takeover actions.
 *
 * Lives on the overview tab rather than access: access is about *what the user may
 * do* (roles), while password / 2FA / passkeys are *how the user proves who they
 * are* — the same identity story the overview already tells. Unlike the ban/delete
 * cluster it stays rendered for `isSelf` and for actors without the credential
 * permission, because the facts are exactly what an admin is called to look up.
 */
const SecuritySection = memo<SecuritySectionProps>(
  ({ canManageCredentials, onDisableTwoFactor, onSetPassword, user }) => {
    const { t } = useTranslation('admin');

    const setPasswordDisabledReason = resolveSetPasswordDisabledReason({
      hasPassword: user.hasPassword,
      isLive: Boolean(onSetPassword),
      isSelf: user.isSelf,
    });
    const disableTwoFactorDisabledReason = resolveDisableTwoFactorDisabledReason({
      isLive: Boolean(onDisableTwoFactor),
    });

    // A passkey-only account (2FA off, passkeys present) is the ordinary state of a
    // passkey user — and the one an admin is called about when the device holding
    // the only passkey is gone. Offer the recovery action there too, worded for
    // what the account actually has.
    const canRecoverCredentials = hasRecoverableCredentials(user);
    const recoveryVariant = resolveCredentialRecoveryVariant(user);
    const recoveryAction = resolveCredentialRecoveryCopy(recoveryVariant, 'action');

    return (
      <div className={styles.section}>
        <Text as="h3" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
          {t('users.security.title')}
        </Text>
        <dl className={styles.dl}>
          <dt>{t('users.security.password.label')}</dt>
          {/* The fact only: why it is not set (SSO-only) is the button's tooltip. */}
          <dd>
            {user.hasPassword
              ? t('users.security.password.set')
              : t('users.security.password.notSet')}
          </dd>
          <dt>{t('users.security.twoFactor.label')}</dt>
          <dd>
            {user.twoFactorEnabled
              ? t('users.security.twoFactor.on')
              : t('users.security.twoFactor.off')}
          </dd>
          <dt>{t('users.security.passkey.label')}</dt>
          <dd>
            {user.passkeyCount > 0
              ? t('users.security.passkey.count', { num: user.passkeyCount })
              : t('users.security.passkey.none')}
          </dd>
        </dl>
        {canManageCredentials ? (
          <div className={styles.actions}>
            <Tooltip title={setPasswordDisabledReason ? t(setPasswordDisabledReason as never) : ''}>
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
            {canRecoverCredentials ? (
              <Tooltip
                title={
                  disableTwoFactorDisabledReason ? t(disableTwoFactorDisabledReason as never) : ''
                }
              >
                <span>
                  <Button
                    danger
                    disabled={Boolean(disableTwoFactorDisabledReason)}
                    size="small"
                    onClick={onDisableTwoFactor}
                  >
                    {t(recoveryAction.key as never, { defaultValue: recoveryAction.defaultValue })}
                  </Button>
                </span>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  },
);

SecuritySection.displayName = 'AdminUserSecuritySection';

export default SecuritySection;
