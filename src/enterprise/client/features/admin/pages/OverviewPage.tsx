'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { OverviewDashboard } from '@/enterprise/client/features/admin/overview';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import TimeRangeFilter, { useAdminTimeRange } from '../primitives/TimeRangeFilter';

const OverviewPage = memo(() => {
  const { t } = useTranslation('admin');
  const { customFrom, customTo, range, rangeKey, setCustomRange, setRangeKey } =
    useAdminTimeRange();

  return (
    <AdminPageTemplate
      description={t('overview.desc')}
      title={t('overview.title')}
      actions={
        <TimeRangeFilter
          customFrom={customFrom}
          customTo={customTo}
          rangeKey={rangeKey}
          setCustomRange={setCustomRange}
          setRangeKey={setRangeKey}
        />
      }
    >
      <OverviewDashboard range={range} />
    </AdminPageTemplate>
  );
});

OverviewPage.displayName = 'AdminOverviewPage';

export default OverviewPage;
