'use client';

import { Text } from '@lobehub/ui';
import { Fragment, memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import { formatAdminDateTime } from '../utils';
import { detailStyles as styles } from './detailStyles';

/** How the account signs in: one row per linked identity provider. */
export const OverviewProvidersSection = memo<{
  providers: AdminUsersGetOutput['providers'];
}>(({ providers }) => {
  const { t } = useTranslation('admin');

  return (
    <section className={styles.section}>
      <Text as="h3" className={styles.sectionTitle}>
        {t('users.overview.providers')}
      </Text>
      {providers.length === 0 ? (
        <Text style={{ fontSize: 13 }} type="secondary">
          {t('users.overview.noProviders')}
        </Text>
      ) : (
        <dl className={styles.dl}>
          {providers.map((p) => (
            <Fragment key={`${p.providerId}-${p.createdAt?.toString() ?? ''}`}>
              <dt>
                {t(`users.providers.${p.providerId}` as never, {
                  defaultValue: p.providerId,
                })}
              </dt>
              <dd>
                {[
                  p.accountIdHint ? `(${p.accountIdHint})` : null,
                  p.createdAt ? formatAdminDateTime(p.createdAt) : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </section>
  );
});

OverviewProvidersSection.displayName = 'AdminUserOverviewProvidersSection';
