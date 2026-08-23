'use client';

import { Text } from '@lobehub/ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import { formatAuditReason } from '../../audit/shared/auditReasonCodes';
import StatusBadge from '../../primitives/StatusBadge';
import UserSourceTags from '../UserSourceTags';
import { formatAdminDateTime } from '../utils';
import { detailStyles as styles } from './detailStyles';

/** Who the account is: identity facts, status and — while banned — the ban record. */
export const OverviewIdentitySection = memo<{ user: AdminUsersGetOutput }>(({ user }) => {
  const { t } = useTranslation('admin');
  const providerIds = useMemo(() => user.providers.map((p) => p.providerId), [user.providers]);

  return (
    <section className={styles.section}>
      <Text as="h3" className={styles.sectionTitle}>
        {t('users.overview.identity')}
      </Text>
      <dl className={styles.dl}>
        <dt>{t('users.overview.email')}</dt>
        <dd>{user.email ?? '—'}</dd>
        <dt>{t('users.overview.username')}</dt>
        <dd>{user.username ?? '—'}</dd>
        <dt>{t('users.overview.fullName')}</dt>
        <dd>{user.fullName ?? '—'}</dd>
        <dt>{t('users.overview.jobTitle')}</dt>
        <dd>{user.dingtalkTitle?.trim() ? user.dingtalkTitle : '—'}</dd>
        <dt>{t('users.overview.status')}</dt>
        <dd>
          <StatusBadge status={user.status} />
        </dd>
        <dt>{t('users.overview.source')}</dt>
        <dd>
          <UserSourceTags providerIds={providerIds} />
        </dd>
        {user.banned ? (
          <>
            <dt>{t('users.overview.banReason')}</dt>
            <dd>
              {formatAuditReason(user.banReason, (key, options) =>
                String(t(key as never, options as never)),
              ) ?? '—'}
            </dd>
            <dt>{t('users.overview.banExpires')}</dt>
            <dd>{formatAdminDateTime(user.banExpires)}</dd>
          </>
        ) : null}
        <dt>{t('users.overview.createdAt')}</dt>
        <dd>{formatAdminDateTime(user.createdAt)}</dd>
        <dt>{t('users.overview.lastActiveAt')}</dt>
        <dd>{formatAdminDateTime(user.lastActiveAt)}</dd>
      </dl>
    </section>
  );
});

OverviewIdentitySection.displayName = 'AdminUserOverviewIdentitySection';
