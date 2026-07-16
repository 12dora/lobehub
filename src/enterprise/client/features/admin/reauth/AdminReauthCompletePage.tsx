'use client';

import { Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { ADMIN_REAUTH_MESSAGE_TYPE } from './requestAdminReauth';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    justify-content: center;

    min-height: 40vh;
    padding: 24px;
  `,
}));

/**
 * Popup landing after reauth sign-in.
 * Echoes only the validated `state` query param to window.opener — never reasons/tokens.
 */
const AdminReauthCompletePage = memo(() => {
  const { t } = useTranslation('admin');
  const [params] = useSearchParams();

  useEffect(() => {
    const state = params.get('state');
    // Only echo state when present and well-formed (hex from createAdminReauthState).
    const safeState = state && /^[a-f0-9]{32,128}$/i.test(state) ? state : null;

    try {
      if (window.opener && window.opener !== window && safeState) {
        window.opener.postMessage(
          {
            status: 'success',
            state: safeState,
            type: ADMIN_REAUTH_MESSAGE_TYPE,
          },
          window.location.origin,
        );
      }
    } catch {
      // ignore
    }

    const handle = window.setTimeout(() => {
      try {
        window.close();
      } catch {
        // ignore
      }
    }, 100);
    return () => window.clearTimeout(handle);
  }, [params]);

  return (
    <div className={styles.root} role="status">
      <Text>{t('users.reauth.complete')}</Text>
    </div>
  );
});

AdminReauthCompletePage.displayName = 'AdminReauthCompletePage';

export default AdminReauthCompletePage;
