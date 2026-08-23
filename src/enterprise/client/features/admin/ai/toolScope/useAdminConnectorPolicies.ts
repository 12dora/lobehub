'use client';

import { useCallback } from 'react';

import type { ConnectorToolPermission } from '@/database/schemas';
import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import type { AdminToolScopeCapabilities } from '@/features/AdminToolScope';
import type { ConnectorWithTools } from '@/store/tool/slices/connector/types';

import type { AdminConnectorGetOutput } from '../../connectors/types';
import type { BuiltinToolPolicies } from './adminConnectorRows';
import { groupToolIdsByTarget, splitPrefixedToolId } from './adminConnectorToolIds';
import {
  BUILTIN_ROW_PREFIX,
  permissionToPolicy,
  PLATFORM_TOOL_PREFIX,
  REASONS,
} from './adminToolScopeHelpers';
import { LOCAL_ERROR } from './toolScopeErrors';
import type { AdminToolScopeSectionParams } from './toolScopeSection';
import type { useAdminConnectorCatalog } from './useAdminConnectorCatalog';

type ConnectorCatalog = ReturnType<typeof useAdminConnectorCatalog>;

interface UseAdminConnectorPoliciesParams {
  capabilities: AdminToolScopeCapabilities;
  connectorDetailById: ConnectorCatalog['connectorDetailById'];
  governance: ConnectorCatalog['governance'];
  mutateGovernance: ConnectorCatalog['mutateGovernance'];
  notifications: AdminToolScopeSectionParams['notifications'];
  retry: ConnectorCatalog['retry'];
}

/**
 * Connector policy writes. Builtin rows edit the ORG governance matrix
 * (platform_connector_governance); platform rows edit their own connector
 * document through a CAS applyImmediate.
 */
export const useAdminConnectorPolicies = ({
  capabilities,
  connectorDetailById,
  governance,
  mutateGovernance,
  notifications,
  retry,
}: UseAdminConnectorPoliciesParams) => {
  const { notifyConnectorFailure, notifyConnectorSaved, notifyUnlessAlreadyToasted } =
    notifications;

  // Builtin rows fall back to read-only while governance is missing or the
  // admin lacks update.
  const isConnectorReadOnly = useCallback(
    (connector: ConnectorWithTools) =>
      !capabilities.canUpdateConnector ||
      (connector.id.startsWith(BUILTIN_ROW_PREFIX) && !governance),
    [capabilities.canUpdateConnector, governance],
  );

  const updateBuiltinPolicies = useCallback(
    async (patch: (policies: BuiltinToolPolicies) => BuiltinToolPolicies) => {
      try {
        if (!capabilities.canUpdateConnector) throw new Error(LOCAL_ERROR.PERMISSION);
        const current = await adminConnectorsService.getGovernance();
        await adminConnectorsService.updateBuiltinToolPolicy({
          expectedRevision: current.revision,
          policies: patch(current.doc.builtinToolPolicies ?? {}),
          reason: REASONS.builtinToolPolicy,
        });
        notifyConnectorSaved();
        await mutateGovernance();
      } catch (err) {
        // Service wrapper toasts hard failures; cover getGovernance + local deny.
        notifyUnlessAlreadyToasted(notifyConnectorFailure, err);
        throw err;
      }
    },

    [
      capabilities.canUpdateConnector,
      mutateGovernance,
      notifyConnectorFailure,
      notifyConnectorSaved,
      notifyUnlessAlreadyToasted,
    ],
  );

  const applyConnectorToolsPatch = useCallback(
    async (
      connectorId: string,
      patchTools: (
        tools: NonNullable<AdminConnectorGetOutput['draft']['tools']>,
      ) => NonNullable<AdminConnectorGetOutput['draft']['tools']>,
    ) => {
      try {
        if (!capabilities.canUpdateConnector) throw new Error(LOCAL_ERROR.PERMISSION);
        const cached = connectorDetailById.get(connectorId);
        const detail = cached ?? (await adminConnectorsService.get({ id: connectorId }));
        const tools = detail.draft.tools ?? [];
        await adminConnectorsService.applyImmediate({
          expectedDraftToken: detail.draftToken,
          expectedRevision: detail.baseRevision,
          id: connectorId,
          mode: 'update',
          reason: REASONS.connectorPolicy,
          tools: patchTools(tools),
        });
        notifyConnectorSaved();
        retry();
      } catch (err) {
        // applyImmediate toasts hard failures; cover get() + local deny.
        notifyUnlessAlreadyToasted(notifyConnectorFailure, err);
        throw err;
      }
    },
    [
      capabilities.canUpdateConnector,
      connectorDetailById,
      notifyConnectorFailure,
      notifyConnectorSaved,
      notifyUnlessAlreadyToasted,
      retry,
    ],
  );

  const updateToolPermission = useCallback(
    async (toolId: string, permission: ConnectorToolPermission) => {
      if (toolId.startsWith(BUILTIN_ROW_PREFIX)) {
        // `admin-builtin:<identifier>:<toolName>` → org governance matrix entry.
        const { name: toolName, owner: identifier } = splitPrefixedToolId(toolId);
        await updateBuiltinPolicies((policies) => ({
          ...policies,
          [identifier]: { ...policies[identifier], [toolName]: permission },
        }));
        return;
      }
      if (!toolId.startsWith(PLATFORM_TOOL_PREFIX)) return;
      const { name: toolKey, owner: connectorId } = splitPrefixedToolId(toolId);
      const policy = permissionToPolicy(permission);
      await applyConnectorToolsPatch(connectorId, (tools) =>
        tools.map((tool) => (tool.toolKey === toolKey ? { ...tool, ...policy } : tool)),
      );
    },
    [applyConnectorToolsPatch, updateBuiltinPolicies],
  );

  /**
   * Apply one permission to a whole group in a SINGLE write per backing document:
   * one governance update for the builtin matrix, one CAS applyImmediate per
   * platform connector. Fanning out per tool would race the same expected
   * revision and fail every write but the first (PLATFORM_REVISION_CONFLICT).
   */
  const updateToolsPermission = useCallback(
    async (toolIds: string[], permission: ConnectorToolPermission) => {
      const { builtinByIdentifier, platformByConnector } = groupToolIdsByTarget(toolIds);

      if (builtinByIdentifier.size > 0) {
        await updateBuiltinPolicies((policies) => {
          const next = { ...policies };
          for (const [identifier, toolNames] of builtinByIdentifier) {
            const entry = { ...next[identifier] };
            for (const toolName of toolNames) entry[toolName] = permission;
            next[identifier] = entry;
          }
          return next;
        });
      }

      const policy = permissionToPolicy(permission);
      // Sequential: each connector is its own CAS document, and the cached
      // detail map only refreshes after a completed write.
      for (const [connectorId, toolKeys] of platformByConnector) {
        const targets = new Set(toolKeys);
        await applyConnectorToolsPatch(connectorId, (tools) =>
          tools.map((tool) => (targets.has(tool.toolKey) ? { ...tool, ...policy } : tool)),
        );
      }
    },
    [applyConnectorToolsPatch, updateBuiltinPolicies],
  );

  const resetConnectorPermissions = useCallback(
    async (connectorId: string) => {
      if (connectorId.startsWith(BUILTIN_ROW_PREFIX)) {
        // Reset = drop this builtin's org overrides so every tool reverts to auto.
        const identifier = connectorId.slice(BUILTIN_ROW_PREFIX.length);
        await updateBuiltinPolicies((policies) => {
          const next = { ...policies };
          delete next[identifier];
          return next;
        });
        return;
      }
      await applyConnectorToolsPatch(connectorId, (tools) =>
        tools.map((tool) => ({
          ...tool,
          platformPolicy: 'allow' as const,
          requiresConfirmation: false,
        })),
      );
    },
    [applyConnectorToolsPatch, updateBuiltinPolicies],
  );

  return {
    isConnectorReadOnly,
    resetConnectorPermissions,
    updateToolPermission,
    updateToolsPermission,
  };
};
