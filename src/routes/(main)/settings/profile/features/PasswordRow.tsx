'use client';

import { Flexbox, Skeleton, Text } from '@lobehub/ui';
import { Button, toast, Tooltip } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSession } from '@/libs/better-auth/auth-client';
import { useUserStore } from '@/store/user';
import { authSelectors, userProfileSelectors } from '@/store/user/selectors';

import ProfileRow from './ProfileRow';
import { openChangePasswordModal } from './security/ChangePasswordModal';
import { openTwoFactorModal } from './security/TwoFactor';

const styles = createStaticStyles(({ css }) => ({
  status: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextDescription};
  `,
  statusOn: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorSuccess};
  `,
}));

const readTwoFactorEnabled = (user: unknown): boolean =>
  Boolean((user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled);

/**
 * The password row carries both credential controls: an in-app password change and the
 * second-factor manager.
 *
 * Which controls apply depends on whether this account has a Better Auth `credential`
 * account at all (`authSelectors.hasPasswordAccount`). SSO-only accounts have no password
 * to change and no second factor of ours to manage — their IdP owns that — so the
 * two-step control is disabled with the reason attached rather than hidden, and the status
 * line says so. Nothing renders a definite answer until `isLoadedAuthProviders` says the
 * answer has actually arrived.
 */
const PasswordRow = () => {
  const { t } = useTranslation('auth');
  const userProfile = useUserStore(userProfileSelectors.userProfile);
  const hasPasswordAccount = useUserStore(authSelectors.hasPasswordAccount);
  const isLoadedAuthProviders = useUserStore(authSelectors.isLoadedAuthProviders);
  const { data: session, isPending: isSessionPending } = useSession();
  const [sending, setSending] = useState(false);

  const email = userProfile?.email;
  const twoFactorEnabled = readTwoFactorEnabled(session?.user);
  const sessionUnknown = isSessionPending && !session;

  // Users who have never set a password (SSO-only) cannot supply a current password, so the
  // only route open to them is the email link — kept as the row's primary action for them.
  const handleSetPasswordByEmail = useCallback(async () => {
    if (!email) return;

    setSending(true);
    try {
      const { requestPasswordReset } = await import('@/libs/better-auth/auth-client');
      const { error } = await requestPasswordReset({
        email,
        redirectTo: `/reset-password?email=${encodeURIComponent(email)}`,
      });
      if (error) {
        toast.error(error.message || t('profile.resetPasswordError'));
        return;
      }
      toast.success(t('profile.resetPasswordSent'));
    } catch (error) {
      console.error('Failed to send reset password email:', error);
      toast.error(t('profile.resetPasswordError'));
    } finally {
      setSending(false);
    }
  }, [email, t]);

  const statusLine = () => {
    if (!isLoadedAuthProviders) {
      return <Skeleton.Button active size="small" style={{ height: 18, width: 140 }} />;
    }
    if (!hasPasswordAccount) {
      return (
        <Text as="span" className={styles.status}>
          {t('profile.security.twoFactor.status.unsupported')}
        </Text>
      );
    }
    if (sessionUnknown) {
      return <Skeleton.Button active size="small" style={{ height: 18, width: 140 }} />;
    }
    return (
      <Text as="span" className={twoFactorEnabled ? styles.statusOn : styles.status}>
        {twoFactorEnabled
          ? t('profile.security.twoFactor.status.on')
          : t('profile.security.twoFactor.status.off')}
      </Text>
    );
  };

  const twoFactorButton = (
    <Button
      disabled={!isLoadedAuthProviders || !hasPasswordAccount}
      size="small"
      onClick={() => openTwoFactorModal()}
    >
      {t('profile.security.twoFactor.action')}
    </Button>
  );

  return (
    <ProfileRow
      label={t('profile.password')}
      action={
        <Flexbox horizontal gap={8}>
          {hasPasswordAccount ? (
            <Button
              disabled={!isLoadedAuthProviders}
              size="small"
              onClick={() => openChangePasswordModal({ email: email ?? undefined })}
            >
              {t('profile.security.password.action')}
            </Button>
          ) : (
            <Button
              disabled={!isLoadedAuthProviders || !email}
              loading={sending}
              size="small"
              onClick={() => void handleSetPasswordByEmail()}
            >
              {t('profile.setPassword')}
            </Button>
          )}
          {isLoadedAuthProviders && !hasPasswordAccount ? (
            // Tooltips do not fire on a disabled control, so the trigger is the wrapper.
            <Tooltip title={t('profile.security.twoFactor.ssoHint')}>
              <span>{twoFactorButton}</span>
            </Tooltip>
          ) : (
            twoFactorButton
          )}
        </Flexbox>
      }
    >
      {statusLine()}
    </ProfileRow>
  );
};

export default PasswordRow;
