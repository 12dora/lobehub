'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const OverviewPage = memo(() => {
  const { t } = useTranslation('admin');

  return (
    <Flexbox gap={12}>
      <Text as="h1" style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
        {t('overview.title')}
      </Text>
      <Text type="secondary">{t('overview.desc')}</Text>
      <Text style={{ fontSize: 13 }} type="secondary">
        {t('overview.placeholderNote')}
      </Text>
    </Flexbox>
  );
});

OverviewPage.displayName = 'AdminOverviewPage';

export default OverviewPage;
