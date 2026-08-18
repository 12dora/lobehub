'use client';

import { isDesktop } from '@lobechat/const';
import { Text } from '@lobehub/ui';
import { Button, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSession } from '@/libs/better-auth/auth-client';

import { securityStyles } from '../styles';
import DisableTotpView from './DisableTotpView';
import PasskeySection from './PasskeySection';
import RegenerateCodesView from './RegenerateCodesView';
import TotpEnrollFlow from './TotpEnrollFlow';

const styles = createStaticStyles(({ css }) => ({
  status: css`
    flex-shrink: 0;

    padding-block: 1px;
    padding-inline: 8px;
    border-radius: ${cssVar.borderRadiusSM};

    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillSecondary};
  `,
  statusOn: css`
    color: ${cssVar.colorSuccess};
    background: ${cssVar.colorSuccessBg};
  `,
}));

type View = 'overview' | 'enroll' | 'disable' | 'regenerate';

/**
 * Live dismiss state shared with the opener's `onOpenChange`. base-ui commits an Escape
 * close before the callback runs, so the veto is "re-open unless the close was explicit".
 */
export interface TwoFactorDismissGuard {
  closedExplicitly: boolean;
  locked: boolean;
}

interface TwoFactorContentProps {
  dismissGuardRef: { current: TwoFactorDismissGuard };
}

const readTwoFactorEnabled = (user: unknown): boolean =>
  Boolean((user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled);

/**
 * Both second factors in one place: an authenticator app and passkeys. Everything that
 * changes state happens as a sub-view of this modal rather than a nested dialog, so the
 * user never loses sight of which account and which factor they are editing.
 */
const TwoFactorContent = memo<TwoFactorContentProps>(({ dismissGuardRef }) => {
  const { t } = useTranslation('auth');
  const { t: tCommon } = useTranslation('common');
  const { close } = useModalContext();

  // Subscribed inside the modal: `createModal` snapshots its content element once.
  const { data: session, isPending, refetch } = useSession();
  const [view, setView] = useState<View>('overview');

  const twoFactorEnabled = readTwoFactorEnabled(session?.user);
  const sessionUnknown = isPending && !session;

  const handleClose = useCallback(() => {
    dismissGuardRef.current.closedExplicitly = true;
    close();
  }, [close, dismissGuardRef]);

  const handleLockChange = useCallback(
    (locked: boolean) => {
      dismissGuardRef.current.locked = locked;
    },
    [dismissGuardRef],
  );

  const backToOverview = useCallback(() => setView('overview'), []);

  // `verifyTotp` / `disable` rotate the session cookie server-side; pull the fresh copy so
  // the On/Off state the user just changed is the one they see.
  const finishAndRefresh = useCallback(() => {
    setView('overview');
    refetch?.();
  }, [refetch]);

  if (view === 'enroll') {
    return (
      <div className={securityStyles.body}>
        <TotpEnrollFlow
          onCancel={backToOverview}
          onDone={finishAndRefresh}
          onLockChange={handleLockChange}
        />
      </div>
    );
  }

  if (view === 'disable') {
    return (
      <div className={securityStyles.body}>
        <DisableTotpView onCancel={backToOverview} onDone={finishAndRefresh} />
      </div>
    );
  }

  if (view === 'regenerate') {
    return (
      <div className={securityStyles.body}>
        <RegenerateCodesView
          onCancel={backToOverview}
          onDone={backToOverview}
          onLockChange={handleLockChange}
        />
      </div>
    );
  }

  return (
    <div className={securityStyles.body}>
      <Text as="h2" className={securityStyles.title}>
        {t('profile.security.twoFactor.title')}
      </Text>
      <Text className={securityStyles.desc}>{t('profile.security.twoFactor.subtitle')}</Text>

      <div className={securityStyles.section}>
        <div className={securityStyles.sectionHead}>
          <Text as="h3" className={securityStyles.title}>
            {t('profile.security.twoFactor.totp.title')}
          </Text>
          {!sessionUnknown && (
            <span className={`${styles.status} ${twoFactorEnabled ? styles.statusOn : ''}`}>
              {twoFactorEnabled
                ? t('profile.security.twoFactor.totp.on')
                : t('profile.security.twoFactor.totp.off')}
            </span>
          )}
        </div>
        <Text className={securityStyles.desc}>{t('profile.security.twoFactor.totp.desc')}</Text>

        {sessionUnknown ? (
          <Text className={securityStyles.desc}>{tCommon('loading')}</Text>
        ) : (
          <div className={securityStyles.footer}>
            {twoFactorEnabled ? (
              <>
                <Button onClick={() => setView('regenerate')}>
                  {t('profile.security.twoFactor.backupCodes.regenerate')}
                </Button>
                <Button danger onClick={() => setView('disable')}>
                  {t('profile.security.twoFactor.totp.turnOff')}
                </Button>
              </>
            ) : (
              <Button type="primary" onClick={() => setView('enroll')}>
                {t('profile.security.twoFactor.totp.setUp')}
              </Button>
            )}
          </div>
        )}
      </div>

      {/*
        The desktop renderer is served from `app://renderer` while the passkey RP
        and accepted origin are pinned to the remote APP_URL, so no ceremony can
        complete here — listing and adding passkeys are both dead ends. Drop the
        whole section (divider included) rather than show controls that can only
        fail. `isDesktop` is the same build constant that hides the password row.
      */}
      {!isDesktop && (
        <>
          <hr className={securityStyles.divider} />
          <PasskeySection />
        </>
      )}

      <div className={securityStyles.footer}>
        <Button onClick={handleClose}>{t('profile.security.close')}</Button>
      </div>
    </div>
  );
});

TwoFactorContent.displayName = 'TwoFactorContent';

export default TwoFactorContent;
