'use client';

import { Empty } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '../primitives/AdminPageTemplate';

/**
 * Platform-level "General settings" surface (系统 → 通用设置).
 *
 * Intentionally empty for now: the page is registered so the 系统 group has a stable
 * first entry, and it states plainly that settings land in a later release instead of
 * pretending to be a broken form. Distinct from `securityAuth` 通用设置 (registration /
 * login policy) and from 审计 通用设置 (retention).
 */
const SystemGeneralPage = memo(() => {
  const { t } = useTranslation('admin');

  return (
    <AdminPageTemplate
      description={t('systemGeneral.description')}
      title={t('systemGeneral.title')}
    >
      <Empty description={t('systemGeneral.empty')} style={{ paddingBlock: 64 }} />
    </AdminPageTemplate>
  );
});

SystemGeneralPage.displayName = 'SystemGeneralPage';

export default SystemGeneralPage;
