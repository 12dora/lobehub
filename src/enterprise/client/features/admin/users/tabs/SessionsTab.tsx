'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import { formatAdminDateTime } from '../utils';
import { detailStyles } from './detailStyles';

const styles = createStaticStyles(({ css }) => ({
  list: css`
    display: flex;
    flex-direction: column;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
  `,
  /** Facts on one secondary line: created · expires · ip. */
  meta: css`
    overflow: hidden;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;

    font-size: 12px;
    line-height: 18px;
    color: ${cssVar.colorTextSecondary};
  `,
  metaItem: css`
    display: inline-flex;
    gap: 4px;
    align-items: baseline;
    white-space: nowrap;

    b {
      font-weight: 400;
      color: ${cssVar.colorTextTertiary};
    }
  `,
  /** One session: device line + facts line, revoke pinned right. */
  row: css`
    display: flex;
    gap: 12px;
    align-items: flex-start;

    padding-block: 10px;
    padding-inline: 12px;

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    }

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  rowMain: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;

    min-width: 0;
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
    <div className={detailStyles.root}>
      <section className={detailStyles.section}>
        <div className={detailStyles.sectionHeader}>
          <Text as="h3" className={detailStyles.sectionTitle}>
            {t('users.sessions.title', { count: user.sessionCount })}
          </Text>
          {canRevoke && onRevokeAll ? (
            <Button danger size="small" type="default" onClick={onRevokeAll}>
              {t('users.sessions.openRevoke')}
            </Button>
          ) : null}
        </div>
        <Text style={{ fontSize: 12 }} type="secondary">
          {t('users.sessions.tokenNote')}
          {user.isSelf ? ` ${t('users.sessions.selfRetainNote')}` : ''}
        </Text>
        {user.sessions.length === 0 ? (
          <Text style={{ fontSize: 13 }} type="secondary">
            {t('users.sessions.empty')}
          </Text>
        ) : (
          <div className={styles.list}>
            {user.sessions.map((s) => (
              <div className={styles.row} key={s.id}>
                <div className={styles.rowMain}>
                  <Text ellipsis style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>
                    {s.userAgent ?? t('users.sessions.unknownDevice')}
                  </Text>
                  <div className={styles.meta}>
                    <span className={styles.metaItem}>
                      <b>{t('users.sessions.createdAt')}</b>
                      {formatAdminDateTime(s.createdAt)}
                    </span>
                    <span className={styles.metaItem}>
                      <b>{t('users.sessions.expiresAt')}</b>
                      {formatAdminDateTime(s.expiresAt)}
                    </span>
                    <span className={styles.metaItem}>
                      <b>{t('users.sessions.ip')}</b>
                      {s.ipAddress ?? '—'}
                    </span>
                  </div>
                </div>
                {canRevoke && onRevokeSession ? (
                  <Button danger size="small" type="text" onClick={() => onRevokeSession(s.id)}>
                    {t('users.sessions.revokeOne')}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {!canRevoke ? (
          <Text style={{ fontSize: 12 }} type="secondary">
            {t('users.sessions.noPermission')}
          </Text>
        ) : null}
      </section>
    </div>
  );
});

SessionsTab.displayName = 'AdminUserSessionsTab';

export default SessionsTab;
