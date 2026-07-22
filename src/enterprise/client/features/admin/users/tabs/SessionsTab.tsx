'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import { formatAdminDateTime } from '../utils';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
  `,
  cardHeader: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  `,
  grid: css`
    display: grid;
    grid-template-columns: minmax(100px, 140px) 1fr;
    gap: 4px 12px;
  `,
}));

interface SessionsTabProps {
  canRevoke: boolean;
  /** Revoke every session for this user. */
  onRevokeAll?: () => void;
  /** Revoke a single session by id. */
  onRevokeSession?: (sessionId: string) => void;
  user: AdminUsersGetOutput;
}

const SessionsTab = memo<SessionsTabProps>(({ user, canRevoke, onRevokeAll, onRevokeSession }) => {
  const { t } = useTranslation('admin');

  return (
    <Flexbox gap={16}>
      <Flexbox horizontal align="center" justify="space-between">
        <Text as="h3" style={{ fontWeight: 600, margin: 0 }}>
          {t('users.sessions.title', { count: user.sessionCount })}
        </Text>
        {canRevoke && onRevokeAll && user.sessions.length > 0 ? (
          <Button danger size="small" type="default" onClick={onRevokeAll}>
            {t('users.sessions.openRevoke')}
          </Button>
        ) : null}
      </Flexbox>
      <Text type="secondary">{t('users.sessions.tokenNote')}</Text>
      {user.isSelf ? <Text type="secondary">{t('users.sessions.selfRetainNote')}</Text> : null}
      {user.sessions.length === 0 ? (
        <Text type="secondary">{t('users.sessions.empty')}</Text>
      ) : (
        <Flexbox gap={8}>
          {user.sessions.map((s) => (
            <div className={styles.card} key={s.id}>
              <div className={styles.cardHeader}>
                <Text ellipsis style={{ fontWeight: 500, margin: 0 }}>
                  {s.id}
                </Text>
                {canRevoke && onRevokeSession ? (
                  <Button danger size="small" type="text" onClick={() => onRevokeSession(s.id)}>
                    {t('users.sessions.revokeOne')}
                  </Button>
                ) : null}
              </div>
              <div className={styles.grid}>
                <Text type="secondary">{t('users.sessions.createdAt')}</Text>
                <Text>{formatAdminDateTime(s.createdAt)}</Text>
                <Text type="secondary">{t('users.sessions.expiresAt')}</Text>
                <Text>{formatAdminDateTime(s.expiresAt)}</Text>
                <Text type="secondary">{t('users.sessions.ip')}</Text>
                <Text>{s.ipAddress ?? '—'}</Text>
                <Text type="secondary">{t('users.sessions.userAgent')}</Text>
                <Text ellipsis>{s.userAgent ?? '—'}</Text>
              </div>
            </div>
          ))}
        </Flexbox>
      )}
      {!canRevoke ? <Text type="secondary">{t('users.sessions.noPermission')}</Text> : null}
    </Flexbox>
  );
});

SessionsTab.displayName = 'AdminUserSessionsTab';

export default SessionsTab;
