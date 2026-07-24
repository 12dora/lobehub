'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '@/enterprise/client/features/admin/primitives/AdminPageTemplate';
import StatsSetting from '@/routes/(main)/settings/stats';

import { adminGlobalStatsDataSource, resolveAdminStatsUser } from './adminStatsDataSource';
import { GlobalStatsBanner } from './GlobalStatsBanner';

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
