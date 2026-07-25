'use client';

import { memo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '@/enterprise/client/features/admin/primitives/AdminPageTemplate';
import StatsSetting from '@/routes/(main)/settings/stats';
import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

import {
  adminGlobalStatsDataSource,
  resetAdminStatsUserDisplayCache,
  resolveAdminStatsUser,
} from './adminStatsDataSource';
import { GlobalStatsBanner } from './GlobalStatsBanner';

const GlobalStatsPage = memo(() => {
  const { t } = useTranslation('admin');
  // Module-level display-name cache is shared for the SPA lifetime — clear when the
  // signed-in admin account changes so GroupBy.User never shows another account's labels.
  const accountUserId = useUserStore(userProfileSelectors.userId);
  useEffect(() => {
    resetAdminStatsUserDisplayCache();
  }, [accountUserId]);

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
