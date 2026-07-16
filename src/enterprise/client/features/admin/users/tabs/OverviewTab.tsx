'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import StatusBadge from '../../primitives/StatusBadge';
import { formatAdminDateTime } from '../utils';

const styles = createStaticStyles(({ css }) => ({
  dl: css`
    display: grid;
    grid-template-columns: 160px 1fr;
    gap: 8px 16px;
    margin: 0;

    dt {
      color: ${cssVar.colorTextSecondary};
    }

    dd {
      margin: 0;
    }
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
}));

const OverviewTab = memo<{ user: AdminUsersGetOutput }>(({ user }) => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.section}>
      <Text as="h3" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
        {t('users.overview.identity')}
      </Text>
      <dl className={styles.dl}>
        <dt>{t('users.overview.id')}</dt>
        <dd>{user.id}</dd>
        <dt>{t('users.overview.email')}</dt>
        <dd>{user.email ?? '—'}</dd>
        <dt>{t('users.overview.username')}</dt>
        <dd>{user.username ?? '—'}</dd>
        <dt>{t('users.overview.fullName')}</dt>
        <dd>{user.fullName ?? '—'}</dd>
        <dt>{t('users.overview.status')}</dt>
        <dd>
          <StatusBadge status={user.status} />
        </dd>
        {user.banned ? (
          <>
            <dt>{t('users.overview.banReason')}</dt>
            <dd>{user.banReason ?? '—'}</dd>
            <dt>{t('users.overview.banExpires')}</dt>
            <dd>{formatAdminDateTime(user.banExpires)}</dd>
          </>
        ) : null}
        <dt>{t('users.overview.createdAt')}</dt>
        <dd>{formatAdminDateTime(user.createdAt)}</dd>
        <dt>{t('users.overview.lastActiveAt')}</dt>
        <dd>{formatAdminDateTime(user.lastActiveAt)}</dd>
      </dl>

      <Text as="h3" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
        {t('users.overview.providers')}
      </Text>
      {user.providers.length === 0 ? (
        <Text type="secondary">{t('users.overview.noProviders')}</Text>
      ) : (
        <Flexbox gap={8}>
          {user.providers.map((p) => (
            <Text key={`${p.providerId}-${p.createdAt?.toString() ?? ''}`}>
              {t(`users.providers.${p.providerId}` as never, { defaultValue: p.providerId })}
              {p.accountIdHint ? ` (${p.accountIdHint})` : ''}
              {p.createdAt ? ` · ${formatAdminDateTime(p.createdAt)}` : ''}
            </Text>
          ))}
        </Flexbox>
      )}
    </div>
  );
});

OverviewTab.displayName = 'AdminUserOverviewTab';

export default OverviewTab;
