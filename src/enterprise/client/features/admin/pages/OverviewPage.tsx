'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '../primitives/AdminPageTemplate';

const OverviewPage = memo(() => {
  const { t } = useTranslation('admin');

  return (
    <AdminPageTemplate description={t('overview.desc')} title={t('overview.title')}>
      <p style={{ fontSize: 13, margin: 0, opacity: 0.75 }}>{t('overview.placeholderNote')}</p>
    </AdminPageTemplate>
  );
});

OverviewPage.displayName = 'AdminOverviewPage';

export default OverviewPage;
