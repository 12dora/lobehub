'use client';

import { useCallback, useMemo } from 'react';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminToolScope } from '@/features/AdminToolScope';

import { deriveToolScopeCapabilities } from './adminToolScopeHelpers';
import { useAdminConnectorScope } from './useAdminConnectorScope';
import { useAdminSkillScope } from './useAdminSkillScope';
import { useToolScopeNotifications } from './useToolScopeNotifications';

/**
 * Builds the org-global datasource for the user-facing skill/connector settings
 * UI rendered inside the admin panel. Every read targets admin.skills /
 * admin.connectors; every write is an applyImmediate (draft + publish) so the
 * change is live for the whole organization.
 */
export const useAdminGlobalToolScope = (view: 'connector' | 'skill'): AdminToolScope => {
  const { permissions } = useAdminAccess();
  const capabilities = useMemo(() => deriveToolScopeCapabilities(permissions), [permissions]);
  const notifications = useToolScopeNotifications();

  const {
    canSetBuiltinSkillDistribution,
    deleteOrgSkill,
    error: skillError,
    getBuiltinSkillDistribution,
    importFromGithub,
    importFromUrl,
    importFromZip,
    installFromMarket,
    isBuiltinSkillEnabled,
    isLoading: skillLoading,
    orgSkills,
    retry: retrySkills,
    setBuiltinSkillDistribution,
    toggleBuiltinSkill,
    useOrgSkillDetail,
  } = useAdminSkillScope({
    capabilities,
    enabled: view === 'skill',
    notifications,
  });

  const {
    connectorNotice,
    connectors,
    deleteConnector,
    error: connectorError,
    isConnectorReadOnly,
    isLoading: connectorLoading,
    resetConnectorPermissions,
    retry: retryConnectors,
    submitCustomConnector,
    updateToolPermission,
    updateToolsPermission,
  } = useAdminConnectorScope({
    capabilities,
    enabled: view === 'connector',
    notifications,
  });

  const retry = useCallback(() => {
    if (view === 'skill') {
      void retrySkills();
      return;
    }
    void retryConnectors();
  }, [retryConnectors, retrySkills, view]);

  const listError = view === 'connector' ? connectorError : skillError;
  const listLoading = view === 'connector' ? connectorLoading : skillLoading;

  return useMemo<AdminToolScope>(
    () => ({
      canSetBuiltinSkillDistribution,
      capabilities,
      connectorNotice,
      connectors,
      deleteConnector,
      deleteOrgSkill,
      getBuiltinSkillDistribution,
      importFromGithub,
      importFromUrl,
      importFromZip,
      installFromMarket,
      isBuiltinSkillEnabled,
      isConnectorReadOnly,
      listError,
      listLoading,
      orgSkills,
      resetConnectorPermissions,
      retry,
      setBuiltinSkillDistribution,
      submitCustomConnector,
      toggleBuiltinSkill,
      updateToolPermission,
      updateToolsPermission,
      useOrgSkillDetail,
    }),
    [
      canSetBuiltinSkillDistribution,
      capabilities,
      connectorNotice,
      connectors,
      deleteConnector,
      deleteOrgSkill,
      getBuiltinSkillDistribution,
      importFromGithub,
      importFromUrl,
      importFromZip,
      installFromMarket,
      isBuiltinSkillEnabled,
      isConnectorReadOnly,
      listError,
      listLoading,
      orgSkills,
      resetConnectorPermissions,
      retry,
      setBuiltinSkillDistribution,
      submitCustomConnector,
      toggleBuiltinSkill,
      updateToolPermission,
      updateToolsPermission,
      useOrgSkillDetail,
    ],
  );
};
