'use client';

import type { AdminToolScopeSectionParams } from './toolScopeSection';
import { useAdminConnectorCatalog } from './useAdminConnectorCatalog';
import { useAdminConnectorLifecycle } from './useAdminConnectorLifecycle';
import { useAdminConnectorPolicies } from './useAdminConnectorPolicies';

type UseAdminConnectorScopeParams = AdminToolScopeSectionParams;

/**
 * Connector half of the admin tool-scope datasource: catalog reads, tool
 * permission writes, and connector create/delete — every write an
 * applyImmediate so the change is live for the whole organization.
 */
export const useAdminConnectorScope = ({
  capabilities,
  enabled,
  notifications,
}: UseAdminConnectorScopeParams) => {
  const {
    connectorDetailById,
    connectorNotice,
    connectors,
    error,
    governance,
    isLoading,
    mutateGovernance,
    retry,
  } = useAdminConnectorCatalog(enabled);

  const {
    isConnectorReadOnly,
    resetConnectorPermissions,
    updateToolPermission,
    updateToolsPermission,
  } = useAdminConnectorPolicies({
    capabilities,
    connectorDetailById,
    governance,
    mutateGovernance,
    notifications,
    retry,
  });

  const { deleteConnector, submitCustomConnector } = useAdminConnectorLifecycle({
    capabilities,
    connectorDetailById,
    notifications,
    retry,
  });

  return {
    connectorNotice,
    connectors,
    deleteConnector,
    error,
    isConnectorReadOnly,
    isLoading,
    resetConnectorPermissions,
    retry,
    submitCustomConnector,
    updateToolPermission,
    updateToolsPermission,
  };
};
