'use client';

import { Alert, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { ADMIN_REAUTH_MESSAGE_TYPE } from './requestAdminReauth';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-items: center;
    justify-content: center;

    min-height: 40vh;
    padding: 24px;
  `,
  panel: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: stretch;

    width: min(420px, 100%);
  `,
}));

export type ReauthCompleteStatus =
  'delivered' | 'invalid' | 'noOpener' | 'deliveryFailed' | 'pending';

export const isSafeReauthState = (state: string | null): state is string =>
  Boolean(state && /^[a-f0-9]{32,128}$/i.test(state));

/**
 * Popup landing after reauth sign-in.
 * Echoes only the validated `state` query param to window.opener — never reasons/tokens.
 * Auto-close only after a successful postMessage; otherwise show an explicit error.
 */
const AdminReauthCompletePage = memo(() => {
  const { t } = useTranslation('admin');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<ReauthCompleteStatus>('pending');

  const safeState = useMemo(() => {
    const state = params.get('state');
    return isSafeReauthState(state) ? state : null;
  }, [params]);

  useEffect(() => {
    if (!safeState) {
      setStatus('invalid');
      return;
    }

    const hasOpener = Boolean(window.opener && window.opener !== window);
    if (!hasOpener) {
      setStatus('noOpener');
      return;
    }

    try {
      window.opener!.postMessage(
        {
          status: 'success',
          state: safeState,
          type: ADMIN_REAUTH_MESSAGE_TYPE,
        },
        window.location.origin,
      );
      setStatus('delivered');
    } catch {
      setStatus('deliveryFailed');
      return;
    }

    // Only auto-close after successful delivery. Script-initiated close is often denied
    // for normal tabs — callers must not claim success when delivery never happened.
    const handle = window.setTimeout(() => {
      try {
        window.close();
      } catch {
        // ignore — page already shows success copy
      }
    }, 100);
    return () => window.clearTimeout(handle);
  }, [safeState]);

  if (status === 'pending') {
    return (
      <div className={styles.root} role="status">
        <Text>{t('users.reauth.complete.pending')}</Text>
      </div>
    );
  }

  if (status === 'delivered') {
    return (
      <div className={styles.root} role="status">
        <Text>{t('users.reauth.complete')}</Text>
      </div>
    );
  }

  const errorCopy =
    status === 'invalid'
      ? {
          description: t('users.reauth.complete.invalid.description'),
          title: t('users.reauth.complete.invalid.title'),
        }
      : status === 'noOpener'
        ? {
            description: t('users.reauth.complete.noOpener.description'),
            title: t('users.reauth.complete.noOpener.title'),
          }
        : {
            description: t('users.reauth.complete.deliveryFailed.description'),
            title: t('users.reauth.complete.deliveryFailed.title'),
          };

  return (
    <div className={styles.root} data-testid="reauth-complete-error">
      <div className={styles.panel}>
        <Alert
          showIcon
          description={errorCopy.description}
          message={errorCopy.title}
          type="error"
        />
        <Button
          onClick={() => {
            try {
              window.close();
            } catch {
              // fall through to navigate
            }
            // If the window cannot close (normal tab), return to admin root.
            void navigate('/admin');
          }}
        >
          {t('users.reauth.complete.close')}
        </Button>
      </div>
    </div>
  );
});

AdminReauthCompletePage.displayName = 'AdminReauthCompletePage';

export default AdminReauthCompletePage;
