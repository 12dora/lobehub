'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import { formatAdminDateTime } from '../utils';

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: grid;
    grid-template-columns: minmax(100px, 140px) 1fr;
    gap: 4px 12px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
  `,
}));

interface SessionsTabProps {
  canRevoke: boolean;
  /** Focus / open the danger-zone revoke action (no divergent logic). */
  onOpenRevoke?: () => void;
  user: AdminUsersGetOutput;
}

const SessionsTab = memo<SessionsTabProps>(({ user, canRevoke, onOpenRevoke }) => {
  const { t } = useTranslation('admin');

  return (
    <Flexbox gap={16}>
      <Flexbox horizontal align="center" justify="space-between">
        <Text as="h3" style={{ fontWeight: 600, margin: 0 }}>
          {t('users.sessions.title', { count: user.sessionCount })}
        </Text>
        {canRevoke && onOpenRevoke ? (
          <Button size="small" type="default" onClick={onOpenRevoke}>
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
            <div className={styles.row} key={s.id}>
              <Text type="secondary">{t('users.sessions.id')}</Text>
              <Text>{s.id}</Text>
              <Text type="secondary">{t('users.sessions.createdAt')}</Text>
              <Text>{formatAdminDateTime(s.createdAt)}</Text>
              <Text type="secondary">{t('users.sessions.expiresAt')}</Text>
              <Text>{formatAdminDateTime(s.expiresAt)}</Text>
              <Text type="secondary">{t('users.sessions.ip')}</Text>
              <Text>{s.ipAddress ?? '—'}</Text>
              <Text type="secondary">{t('users.sessions.userAgent')}</Text>
              <Text ellipsis>{s.userAgent ?? '—'}</Text>
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
