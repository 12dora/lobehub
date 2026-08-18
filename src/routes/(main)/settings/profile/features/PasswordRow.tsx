'use client';

import { Flexbox, Skeleton, Text } from '@lobehub/ui';
import { Button, toast, Tooltip } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useListPasskeys, useSession } from '@/libs/better-auth/auth-client';
import { useUserStore } from '@/store/user';
import { authSelectors, userProfileSelectors } from '@/store/user/selectors';

import ProfileRow from './ProfileRow';
import { authErrorMessageKey } from './security/authErrorMessage';
import { openChangePasswordModal } from './security/ChangePasswordModal';
import { openTwoFactorModal } from './security/TwoFactor';

const styles = createStaticStyles(({ css }) => ({
  retry: css`
    height: auto;
    padding: 0;
    font-size: ${cssVar.fontSizeSM};
  `,
  status: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextDescription};
  `,
  /** Referenced by `aria-describedby`; carries copy the tooltip already shows visually. */
  srOnly: css`
    position: absolute;

    overflow: hidden;

    inline-size: 1px;
    block-size: 1px;

    white-space: nowrap;

    clip-path: inset(50%);
  `,
  statusOn: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorSuccess};
  `,
}));

const UNAVAILABLE_KEY = 'profile.security.status.unavailable';

const readTwoFactorEnabled = (user: unknown): boolean =>
  Boolean((user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled);

/**
 * The row reports two independent facts, because login treats them independently: the TOTP
 * flag (`twoFactorEnabled`) is what makes a password sign-in ask for a second code, while a
 * passkey is a first-factor sign-in method that may skip TOTP entirely. A passkey therefore
 * must never be reported as "two-step verification on" — that would promise a challenge the
 * account does not actually get.
 *
 * `unknown` is set when a query failed. Every positive claim is still made from what did
 * arrive (a confirmed factor is a confirmed factor), but "off" is a claim about the absence
 * of both factors — it needs both answers, so a failure downgrades it to "unavailable"
 * rather than under-reporting the account's protection.
 */
const statusKey = (twoFactorEnabled: boolean, hasPasskey: boolean, unknown: boolean) => {
  if (twoFactorEnabled && hasPasskey) return 'profile.security.status.both';
  if (twoFactorEnabled) return 'profile.security.twoFactor.status.on';
  if (hasPasskey) return 'profile.security.status.passkey';
  if (unknown) return UNAVAILABLE_KEY;
  return 'profile.security.twoFactor.status.off';
};

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
  const { t: tCommon } = useTranslation('common');
  const userProfile = useUserStore(userProfileSelectors.userProfile);
  const hasPasswordAccount = useUserStore(authSelectors.hasPasswordAccount);
  const isLoadedAuthProviders = useUserStore(authSelectors.isLoadedAuthProviders);
  const {
    data: session,
    error: sessionError,
    isPending: isSessionPending,
    refetch: refetchSession,
  } = useSession();
  // Better Auth builds this atom once per client and every `useListPasskeys()` reads the same
  // store, so the list the modal mutates is the list this row renders — adding or removing a
  // passkey repaints the row without a callback on modal close.
  const {
    data: passkeys,
    error: passkeyError,
    isPending: isPasskeyPending,
    refetch: refetchPasskeys,
  } = useListPasskeys();
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const ssoHintId = useId();

  const email = userProfile?.email;
  // A failed query answers nothing. Reading its empty payload as "no TOTP" / "no passkeys"
  // is what turns an outage into a false "two-step verification off".
  const twoFactorEnabled = !sessionError && readTwoFactorEnabled(session?.user);
  const hasPasskey = !passkeyError && (passkeys?.length ?? 0) > 0;
  const statusUnknown = Boolean(sessionError || passkeyError);
  // A failure must not hold the row on a skeleton forever either — it resolves to whatever
  // is still known, or to the neutral "unavailable" line with a retry.
  const sessionUnknown = isSessionPending && !session && !sessionError;
  const passkeysUnknown = isPasskeyPending && !passkeys && !passkeyError;

  const handleRetryStatus = useCallback(async () => {
    setRetrying(true);
    try {
      await Promise.all([
        sessionError ? refetchSession() : undefined,
        passkeyError ? refetchPasskeys() : undefined,
      ]);
    } finally {
      setRetrying(false);
    }
  }, [passkeyError, refetchPasskeys, refetchSession, sessionError]);

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
        // Never `error.message`: Better Auth answers in developer English with stable codes
        // behind it, so the code — not the sentence — is what gets translated.
        const key = authErrorMessageKey(error);
        toast.error(key ? t(key) : t('profile.resetPasswordError'));
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
    if (sessionUnknown || passkeysUnknown) {
      return <Skeleton.Button active size="small" style={{ height: 18, width: 140 }} />;
    }
    const key = statusKey(twoFactorEnabled, hasPasskey, statusUnknown);
    const protectedAccount = twoFactorEnabled || hasPasskey;
    const line = (
      <Text as="span" className={protectedAccount ? styles.statusOn : styles.status}>
        {t(key)}
      </Text>
    );
    // Only the neutral line is actionable: the positive lines are already true, a retry
    // there would just add noise to a settled state.
    if (key !== UNAVAILABLE_KEY) return line;
    return (
      <Flexbox horizontal align="center" gap={8}>
        {line}
        <Button
          className={styles.retry}
          loading={retrying}
          size="small"
          type="link"
          onClick={() => void handleRetryStatus()}
        >
          {tCommon('retry')}
        </Button>
      </Flexbox>
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
            // A disabled button fires no tooltip and takes no focus, so the reason it is
            // dead would reach pointer users only. The wrapper is the trigger *and* is put
            // in the tab order, and it carries the reason as its accessible description —
            // `aria-describedby` is global, so it is the one ARIA attribute a plain span is
            // allowed to answer with.
            <>
              <Tooltip title={t('profile.security.twoFactor.ssoHint')}>
                <span aria-describedby={ssoHintId} tabIndex={0}>
                  {twoFactorButton}
                </span>
              </Tooltip>
              <span className={styles.srOnly} id={ssoHintId}>
                {t('profile.security.twoFactor.ssoHint')}
              </span>
            </>
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
