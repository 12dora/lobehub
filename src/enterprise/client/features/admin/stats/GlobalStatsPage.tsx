'use client';

import { memo, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '@/enterprise/client/features/admin/primitives/AdminPageTemplate';
import TimeRangeFilter, {
  useAdminTimeRange,
} from '@/enterprise/client/features/admin/primitives/TimeRangeFilter';
import StatsSetting from '@/routes/(main)/settings/stats';
import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

import {
  adminGlobalStatsDataSource,
  resetAdminStatsUserDisplayCache,
  resolveAdminStatsUser,
} from './adminStatsDataSource';
import StatsUserFilterSelect from './StatsUserFilterSelect';
import { useStatsUserFilter } from './useStatsUserFilter';

const GlobalStatsPage = memo(() => {
  const { t } = useTranslation('admin');
  // Module-level display-name cache is shared for the SPA lifetime — clear when the
  // signed-in admin account changes so GroupBy.User never shows another account's labels.
  const accountUserId = useUserStore(userProfileSelectors.userId);
  useEffect(() => {
    resetAdminStatsUserDisplayCache();
  }, [accountUserId]);

  const { customFrom, customTo, range, rangeKey, setCustomRange, setRangeKey } =
    useAdminTimeRange();

  // The label is not in the URL (ids are stable, names are not) — it is resolved from the
  // picker or, for a bookmarked/shared id, from the directory.
  const { setUser, userId, userName } = useStatsUserFilter();

  const resolveUser = useCallback(
    (id: string) => resolveAdminStatsUser(id, (index) => t('stats.user.unknown', { index })),
    [t],
  );

  const statsRange = useMemo(
    () => ({ endAt: range.endAt, label: range.label, startAt: range.startAt }),
    [range.endAt, range.label, range.startAt],
  );

  return (
    <AdminPageTemplate
      description={t('stats.page.desc')}
      title={t('stats.page.title')}
      actions={
        <>
          <StatsUserFilterSelect value={userId} valueLabel={userName} onChange={setUser} />
          <TimeRangeFilter
            customFrom={customFrom}
            customTo={customTo}
            rangeKey={rangeKey}
            setCustomRange={setCustomRange}
            setRangeKey={setRangeKey}
          />
        </>
      }
    >
      <StatsSetting
        enableUserDimension
        dataSource={adminGlobalStatsDataSource}
        headerNode={t('stats.section.title')}
        range={statsRange}
        resolveUser={resolveUser}
        showSettingHeader={false}
        userId={userId}
      />
    </AdminPageTemplate>
  );
});

GlobalStatsPage.displayName = 'GlobalStatsPage';

export default GlobalStatsPage;
