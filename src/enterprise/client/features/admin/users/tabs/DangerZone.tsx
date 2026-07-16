'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  `,
  root: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 16px;
    border: 1px solid ${cssVar.colorErrorBorder};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorErrorBg};
  `,
  title: css`
    margin: 0;
    font-size: ${cssVar.fontSizeLG};
    font-weight: 600;
    color: ${cssVar.colorError};
  `,
}));

export interface DangerZoneProps {
  canBan: boolean;
  canRevoke: boolean;
  onBan?: () => void;
  onRevoke?: () => void;
  onUnban?: () => void;
  user: AdminUsersGetOutput;
}

/**
 * Distinct danger zone for ban/unban and session revoke.
 * Role replacement stays on the Access tab.
 */
const DangerZone = memo<DangerZoneProps>(
  ({ user, canBan, canRevoke, onBan, onUnban, onRevoke }) => {
    const { t } = useTranslation('admin');
    const isSelf = user.isSelf;

    return (
      <section aria-labelledby="admin-user-danger-zone" className={styles.root}>
        <Text as="h3" className={styles.title} id="admin-user-danger-zone">
          {t('users.danger.title')}
        </Text>
        <Text type="secondary">{t('users.danger.desc')}</Text>
        <div className={styles.actions}>
          {canBan && !isSelf && user.status !== 'banned' && onBan ? (
            <Button danger size="small" onClick={onBan}>
              {t('users.actions.ban')}
            </Button>
          ) : null}
          {canBan && !isSelf && user.status === 'banned' && onUnban ? (
            <Button size="small" onClick={onUnban}>
              {t('users.actions.unban')}
            </Button>
          ) : null}
          {canBan && isSelf ? (
            <Text type="secondary">{t('users.danger.selfBanHidden')}</Text>
          ) : null}
          {canRevoke && onRevoke ? (
            <Button danger size="small" onClick={onRevoke}>
              {t('users.actions.revokeSessions')}
            </Button>
          ) : null}
        </div>
        {canRevoke && user.isSelf ? (
          <Text type="secondary">{t('users.danger.selfRevokeNote')}</Text>
        ) : null}
      </section>
    );
  },
);

DangerZone.displayName = 'AdminUserDangerZone';

export default DangerZone;
