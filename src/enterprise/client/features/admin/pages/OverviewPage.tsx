'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { OverviewDashboard } from '@/enterprise/client/features/admin/overview';

import AdminPageTemplate from '../primitives/AdminPageTemplate';

const OverviewPage = memo(() => {
  const { t } = useTranslation('admin');

  return (
    <AdminPageTemplate description={t('overview.desc')} title={t('overview.title')}>
      <OverviewDashboard />
    </AdminPageTemplate>
  );
});

OverviewPage.displayName = 'AdminOverviewPage';

export default OverviewPage;
