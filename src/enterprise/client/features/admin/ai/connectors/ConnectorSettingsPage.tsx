'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '@/enterprise/client/features/admin/primitives/AdminPageTemplate';
import { AdminToolScopeProvider } from '@/features/AdminToolScope';
import { ToolSettings } from '@/routes/(main)/settings/skill';

import { useAdminGlobalToolScope } from '../toolScope/useAdminGlobalToolScope';

/**
 * Admin `/admin/ai/connectors`: byte-identical to the user `/settings/connector`
 * surface (built-in tools with grouped sub-tool permissions, OAuth connector
 * catalog, custom connector modal) — rendered against the org-global datasource
 * so platform connectors and their tool policies apply to every user.
 */
const ConnectorSettingsPage = memo(() => {
  const { t } = useTranslation('admin');
  const scope = useAdminGlobalToolScope('connector');

  return (
    <AdminPageTemplate
      fullHeight
      description={t('page.aiConnectors.desc')}
      title={t('nav.aiConnectors')}
    >
      <AdminToolScopeProvider value={scope}>
        <ToolSettings managed={false} viewMode="connector" />
      </AdminToolScopeProvider>
    </AdminPageTemplate>
  );
});

ConnectorSettingsPage.displayName = 'AdminConnectorSettingsPage';

export default ConnectorSettingsPage;
