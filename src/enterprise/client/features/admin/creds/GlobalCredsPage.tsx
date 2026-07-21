'use client';

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '@/enterprise/client/features/admin/primitives/AdminPageTemplate';
import { adminCredsService } from '@/enterprise/client/services/adminCreds';
import Page from '@/routes/(main)/settings/creds';
import {
  type CredsApi,
  CredsApiProvider,
} from '@/routes/(main)/settings/creds/features/useCredsApi';

/**
 * Admin platform-global credential management.
 *
 * Reuses the user-facing credentials page shell via {@link CredsApiProvider},
 * rebinding every consumer to `admin.creds` (platform self-held storage).
 * Same pattern as workspace settings creds → workspaceCreds.
 */
const GlobalCredsPage = memo(() => {
  const { t } = useTranslation('admin');

  const adminCredsApi = useMemo<CredsApi>(
    () => ({
      // admin.creds is a structural subset of market.creds. Cast at the
      // boundary; consumers only touch overlapping members.
      client: adminCredsService.client as unknown as CredsApi['client'],
      mode: 'platform',
      query: adminCredsService.query as unknown as CredsApi['query'],
    }),
    [],
  );

  return (
    <AdminPageTemplate description={t('creds.page.desc')} title={t('creds.page.title')}>
      <CredsApiProvider value={adminCredsApi}>
        <Page />
      </CredsApiProvider>
    </AdminPageTemplate>
  );
});

GlobalCredsPage.displayName = 'GlobalCredsPage';

export default GlobalCredsPage;
