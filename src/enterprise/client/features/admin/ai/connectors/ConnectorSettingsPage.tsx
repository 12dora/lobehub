'use client';

import { memo } from 'react';

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
  const scope = useAdminGlobalToolScope('connector');

  return (
    <AdminToolScopeProvider value={scope}>
      <ToolSettings managed={false} viewMode="connector" />
    </AdminToolScopeProvider>
  );
});

ConnectorSettingsPage.displayName = 'AdminConnectorSettingsPage';

export default ConnectorSettingsPage;
