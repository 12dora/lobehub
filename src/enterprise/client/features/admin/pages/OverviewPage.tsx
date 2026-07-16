'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import SectionGroup from '@/components/SectionGroup';

import AdminPageTemplate from '../primitives/AdminPageTemplate';

const OverviewPage = memo(() => {
  const { t } = useTranslation('admin');

  return (
    <AdminPageTemplate description={t('overview.desc')} title={t('overview.title')}>
      <SectionGroup fontSize={16} title={t('overview.title')}>
        <p style={{ fontSize: 13, margin: 0, opacity: 0.75 }}>{t('overview.placeholderNote')}</p>
      </SectionGroup>
    </AdminPageTemplate>
  );
});

OverviewPage.displayName = 'AdminOverviewPage';

export default OverviewPage;
