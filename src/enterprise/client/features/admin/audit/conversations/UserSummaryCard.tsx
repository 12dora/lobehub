'use client';

import { Alert, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAuditUserSummary } from '@/enterprise/client/services/adminAudit';

import { formatAdminDateTime } from '../shared/format';

const styles = createStaticStyles(({ css }) => ({
  summary: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
}));

export interface UserSummaryCardProps {
  failed: boolean;
  onRetry: () => void;
  user: AdminAuditUserSummary | undefined;
}

/**
 * Identity and activity totals for the audited user. The fields stay on screen with em dashes
 * when the (optional, AUDIT_READ-gated) summary is unavailable, so the page never loses its shape.
 */
const UserSummaryCard = memo<UserSummaryCardProps>(({ failed, onRetry, user }) => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.summary}>
      {failed ? (
        <Alert
          showIcon
          message={t('audit.conversations.user.summaryUnavailable')}
          style={{ gridColumn: '1 / -1' }}
          type="warning"
          action={
            <Button size="small" onClick={onRetry}>
              {t('audit.shared.retryMissingSections')}
            </Button>
          }
        />
      ) : null}
      <div>
        <Text type="secondary">{t('audit.conversations.user.email')}</Text>
        <div>{user?.email ?? '—'}</div>
      </div>
      <div>
        <Text type="secondary">{t('audit.conversations.user.username')}</Text>
        <div>{user?.username ?? '—'}</div>
      </div>
      <div>
        <Text type="secondary">{t('audit.conversations.user.topics')}</Text>
        <div>{user?.topicCount ?? '—'}</div>
      </div>
      <div>
        <Text type="secondary">{t('audit.conversations.user.messages')}</Text>
        <div>{user?.messageCount ?? '—'}</div>
      </div>
      <div>
        <Text type="secondary">{t('audit.conversations.user.lastActive')}</Text>
        <div>{formatAdminDateTime(user?.lastActiveAt)}</div>
      </div>
    </div>
  );
});

UserSummaryCard.displayName = 'AuditUserSummaryCard';

export default UserSummaryCard;
