'use client';

import { Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

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
 * Popup landing page after Better Auth sign-in for admin reauth.
 * Posts a same-origin success message to the opener and closes.
 * Never stores mutation payloads or reasons.
 */
const AdminReauthCompletePage = memo(() => {
  const { t } = useTranslation('admin');

  useEffect(() => {
    try {
      if (window.opener && window.opener !== window) {
        window.opener.postMessage(
          { status: 'success', type: ADMIN_REAUTH_MESSAGE_TYPE },
          window.location.origin,
        );
      }
    } catch {
      // opener may be inaccessible cross-origin; ignore
    }
    // Close popup after signaling; parent also resolves on message.
    const handle = window.setTimeout(() => {
      try {
        window.close();
      } catch {
        // ignore
      }
    }, 100);
    return () => window.clearTimeout(handle);
  }, []);

  return (
    <div className={styles.root} role="status">
      <Text>{t('users.reauth.complete')}</Text>
    </div>
  );
});

AdminReauthCompletePage.displayName = 'AdminReauthCompletePage';

export default AdminReauthCompletePage;
