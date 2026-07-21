'use client';

import { Flexbox, Skeleton, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '@/enterprise/client/features/admin/primitives/AdminPageTemplate';
import { adminStatsService } from '@/enterprise/client/services/adminStats';
import { useClientDataSWR } from '@/libs/swr';
import StatsSetting from '@/routes/(main)/settings/stats';
import { formatIntergerNumber } from '@/utils/format';

import { adminGlobalStatsDataSource, resolveAdminStatsUser } from './adminStatsDataSource';

const styles = createStaticStyles(({ css }) => ({
  banner: css`
    display: flex;
    flex-wrap: wrap;
    gap: 16px 24px;
    align-items: baseline;

    padding-block: 4px;
  `,
  metric: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  metricLabel: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  metricValue: css`
    font-size: 18px;
    font-weight: 600;
  `,
}));

const GlobalStatsBanner = memo(() => {
  const { t } = useTranslation('admin');
  const { data, isLoading } = useClientDataSWR(
    ['admin-stats:totals', adminGlobalStatsDataSource.scopeKey],
    () => adminStatsService.totals(30),
  );

  if (isLoading || !data) {
    return (
      <Flexbox horizontal className={styles.banner}>
        <Skeleton.Button active size="small" style={{ width: 120 }} />
        <Skeleton.Button active size="small" style={{ width: 120 }} />
      </Flexbox>
    );
  }

  return (
    <div className={styles.banner}>
      <div className={styles.metric}>
        <span className={styles.metricValue}>{formatIntergerNumber(data.usersTotal)}</span>
        <span className={styles.metricLabel}>{t('stats.banner.usersTotal')}</span>
      </div>
      <div className={styles.metric}>
        <span className={styles.metricValue}>{formatIntergerNumber(data.usersActive)}</span>
        <span className={styles.metricLabel}>{t('stats.banner.usersActive')}</span>
      </div>
      <Text style={{ fontSize: 12 }} type="secondary">
        {t('stats.banner.scopeNote')}
      </Text>
    </div>
  );
});

GlobalStatsBanner.displayName = 'GlobalStatsBanner';

const GlobalStatsPage = memo(() => {
  const { t } = useTranslation('admin');

  return (
    <AdminPageTemplate description={t('stats.page.desc')} title={t('stats.page.title')}>
      <StatsSetting
        enableUserDimension
        dataSource={adminGlobalStatsDataSource}
        headerNode={<GlobalStatsBanner />}
        resolveUser={resolveAdminStatsUser}
        showSettingHeader={false}
      />
    </AdminPageTemplate>
  );
});

GlobalStatsPage.displayName = 'GlobalStatsPage';

export default GlobalStatsPage;
