'use client';

import { Alert } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import isEqual from 'fast-deep-equal';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { ConnectorToolPermission } from '@/database/schemas';
import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import type { AdminToolScopeCapabilities } from '@/features/AdminToolScope';
import { inferCrudType } from '@/libs/mcp/utils';
import { useClientDataSWR } from '@/libs/swr';
import { useToolStore } from '@/store/tool';
import type { ConnectorTool, ConnectorWithTools } from '@/store/tool/slices/connector/types';

import type { AdminConnectorGetOutput } from '../../connectors/types';
import {
  BUILTIN_ROW_PREFIX,
  listAllAdminConnectors,
  loadAllConnectorDetails,
  permissionToPolicy,
  PLATFORM_TOOL_PREFIX,
  policyToPermission,
  REASONS,
} from './adminToolScopeHelpers';
import { isLocalAdapterError, isPartialCreateMarker, LOCAL_ERROR } from './toolScopeErrors';
import type { useToolScopeNotifications } from './useToolScopeNotifications';

interface UseAdminConnectorScopeParams {
  capabilities: AdminToolScopeCapabilities;
  enabled: boolean;
  notifications: ReturnType<typeof useToolScopeNotifications>;
}

export const useAdminConnectorScope = ({
  capabilities,
  enabled,
  notifications,
}: UseAdminConnectorScopeParams) => {
  const { t } = useTranslation('admin');
  const { notifyConnectorFailure, notifyConnectorSaved, notifyUnlessAlreadyToasted } =
    notifications;
  const builtinTools = useToolStore((s) => s.builtinTools, isEqual);

  // ── platform connector catalog (full list + batched details) ──────────────
  const connectorsListSWR = useClientDataSWR(
    enabled ? 'admin-tool-scope/connectors/all' : null,
    () => listAllAdminConnectors(),
    { revalidateOnFocus: false },
  );
  // Org governance: builtin tool permission matrix + shared OAuth designation.
  const governanceSWR = useClientDataSWR(
    enabled ? 'admin-tool-scope/connectors/governance' : null,
    () => adminConnectorsService.getGovernance(),
    { revalidateOnFocus: false },
  );
  const mutateGovernance = governanceSWR.mutate;
  const governance = governanceSWR.data;
  const builtinToolPolicies = governance?.doc.builtinToolPolicies;
  const connectorListItems = connectorsListSWR.data ?? [];
  const connectorDetailKey = connectorListItems.map((item) => item.id).join('|');
  const connectorDetailsSWR = useClientDataSWR(
    enabled && connectorListItems.length > 0
      ? ['admin-tool-scope/connectors/details', connectorDetailKey]
      : null,
    async () => loadAllConnectorDetails(connectorListItems.map((item) => item.id)),
    { revalidateOnFocus: false },
  );

  const connectorDetails = useMemo(
    () => connectorDetailsSWR.data?.items ?? [],
    [connectorDetailsSWR.data],
  );
  const connectorDetailFailedCount = connectorDetailsSWR.data?.failedIds.length ?? 0;
  const connectorDetailById = useMemo(
    () => new Map(connectorDetails.map((detail) => [detail.draft.id, detail])),
    [connectorDetails],
  );

  const connectors: ConnectorWithTools[] = useMemo(() => {
    // Builtin in-process tools, synthesized from the static manifests with the
    // same crud grouping the user connector sync applies server-side.
    const builtinRows: ConnectorWithTools[] = builtinTools
      .filter((tool) => !tool.hidden)
      .map((tool) => {
        const api = (tool.manifest?.api ?? []) as {
          description?: string;
          name: string;
          parameters?: Record<string, unknown>;
        }[];
        const identifierPolicies = builtinToolPolicies?.[tool.identifier];
        const tools: ConnectorTool[] = api.map((entry) => ({
          crudType: inferCrudType(entry.name),
          description: entry.description ?? null,
          displayName: entry.name,
          id: `${BUILTIN_ROW_PREFIX}${tool.identifier}:${entry.name}`,
          inputSchema: (entry.parameters ?? null) as Record<string, unknown> | null,
          permission: (identifierPolicies?.[entry.name] ??
            ConnectorToolPermission.auto) as ConnectorToolPermission,
          toolName: entry.name,
          userConnectorId: `${BUILTIN_ROW_PREFIX}${tool.identifier}`,
        }));
        return {
          credentials: null,
          id: `${BUILTIN_ROW_PREFIX}${tool.identifier}`,
          identifier: tool.identifier,
          isEnabled: true,
          mcpConnectionType: null,
          mcpServerUrl: null,
          metadata: null,
          name: tool.title || tool.identifier,
          sourceType: 'builtin',
          status: 'connected',
          tools,
        };
      });

    const platformRows: ConnectorWithTools[] = connectorDetails
      .filter((detail) => detail.draft.status !== 'archived')
      .map((detail) => ({
        credentials: null,
        id: detail.draft.id,
        identifier: detail.draft.key,
        isEnabled: detail.draft.enabled ?? true,
        mcpConnectionType: 'http',
        mcpServerUrl: detail.draft.endpoint,
        metadata: detail.draft.description ? { description: detail.draft.description } : null,
        name: detail.draft.displayName,
        sourceType: 'custom',
        status: detail.published ? 'connected' : 'disconnected',
        tools: (detail.draft.tools ?? []).map((tool): ConnectorTool => ({
          crudType: inferCrudType(tool.toolKey),
          description: tool.description ?? null,
          displayName: tool.displayName ?? null,
          id: `${PLATFORM_TOOL_PREFIX}${detail.draft.id}:${tool.toolKey}`,
          inputSchema: (tool.inputSchema ?? null) as Record<string, unknown> | null,
          permission: policyToPermission(tool),
          toolName: tool.toolKey,
          userConnectorId: detail.draft.id,
        })),
      }));

    return [...builtinRows, ...platformRows];
  }, [builtinToolPolicies, builtinTools, connectorDetails]);

  const retry = useCallback(() => {
    void connectorsListSWR.mutate();
    void connectorDetailsSWR.mutate();
    void mutateGovernance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectorsListSWR.mutate, connectorDetailsSWR.mutate, mutateGovernance]);
  const retryGovernance = useCallback(() => {
    void mutateGovernance();
  }, [mutateGovernance]);

  const connectorPartialDetailError =
    connectorDetailFailedCount > 0
      ? new Error(
          t('aiToolSettings.connectors.partialLoadFailed', {
            count: connectorDetailFailedCount,
          }),
        )
      : undefined;
  const governanceFailureActiveRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      governanceFailureActiveRef.current = false;
      return;
    }

    if (governanceSWR.error) {
      if (governanceFailureActiveRef.current) return;
      governanceFailureActiveRef.current = true;
      toast.error(t('aiToolSettings.connectors.governanceLoadFailed'));
      return;
    }

    if (governanceSWR.data && !governanceSWR.isValidating) {
      governanceFailureActiveRef.current = false;
    }
  }, [enabled, governanceSWR.data, governanceSWR.error, governanceSWR.isValidating, t]);

  const error =
    connectorsListSWR.error ??
    governanceSWR.error ??
    connectorDetailsSWR.error ??
    connectorPartialDetailError;
  const isLoading = Boolean(
    (connectorsListSWR.isLoading && !connectorsListSWR.data) ||
    (governanceSWR.isLoading && !governanceSWR.data),
  );

  const connectorNotice = useMemo(
    () =>
      governanceSWR.error ? (
        <Alert
          showIcon
          type="error"
          action={
            <Button onClick={retryGovernance}>
              {t('aiToolSettings.connectors.retryGovernance', {
                defaultValue: 'Retry permissions',
              })}
            </Button>
          }
          message={t('aiToolSettings.connectors.governanceLoadFailed', {
            defaultValue: 'Connector permissions could not be loaded. Retry before making changes.',
          })}
        />
      ) : undefined,
    [governanceSWR.error, retryGovernance, t],
  );

  // ── connector policy writes ───────────────────────────────────────────────
  // Builtin rows edit the ORG governance matrix (platform_connector_governance);
  // they fall back to read-only while governance is missing or the admin lacks update.
  const isConnectorReadOnly = useCallback(
    (connector: ConnectorWithTools) =>
      !capabilities.canUpdateConnector ||
      (connector.id.startsWith(BUILTIN_ROW_PREFIX) && !governance),
    [capabilities.canUpdateConnector, governance],
  );

  const updateBuiltinPolicies = useCallback(
    async (
      patch: (
        policies: NonNullable<typeof builtinToolPolicies>,
      ) => NonNullable<typeof builtinToolPolicies>,
    ) => {
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
        const [, identifier, ...nameParts] = toolId.split(':');
        const toolName = nameParts.join(':');
        await updateBuiltinPolicies((policies) => ({
          ...policies,
          [identifier]: { ...policies[identifier], [toolName]: permission },
        }));
        return;
      }
      if (!toolId.startsWith(PLATFORM_TOOL_PREFIX)) return;
      const [, connectorId, ...toolKeyParts] = toolId.split(':');
      const toolKey = toolKeyParts.join(':');
      const policy = permissionToPolicy(permission);
      await applyConnectorToolsPatch(connectorId, (tools) =>
        tools.map((tool) => (tool.toolKey === toolKey ? { ...tool, ...policy } : tool)),
      );
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

  const deleteConnector = useCallback(
    async (connectorId: string) => {
      try {
        if (connectorId.startsWith(BUILTIN_ROW_PREFIX)) return;
        if (!capabilities.canDeleteConnector) throw new Error(LOCAL_ERROR.PERMISSION);
        const cached = connectorDetailById.get(connectorId);
        const detail = cached ?? (await adminConnectorsService.get({ id: connectorId }));
        if (detail.published) {
          await adminConnectorsService.archiveImmediate({
            expectedDraftToken: detail.draftToken,
            expectedRevision: detail.baseRevision,
            id: connectorId,
            reason: REASONS.connectorDelete,
          });
          toast.success(t('connectorCatalog.toast.archived'));
        } else {
          await adminConnectorsService.deleteDraft({
            expectedDraftToken: detail.draftToken,
            expectedRevision: detail.baseRevision,
            id: connectorId,
            reason: REASONS.connectorDelete,
          });
          toast.success(t('connectorCatalog.toast.deleted'));
        }
        retry();
      } catch (err) {
        // deleteDraft/archiveImmediate toast via wrapper when real; mocks/pre-reads need this.
        notifyUnlessAlreadyToasted(notifyConnectorFailure, err);
        throw err;
      }
    },
    [
      capabilities.canDeleteConnector,
      connectorDetailById,
      notifyConnectorFailure,
      notifyUnlessAlreadyToasted,
      retry,
      t,
    ],
  );

  const submitCustomConnector = useCallback(
    async (values: {
      auth?: { clientId?: string; clientSecret?: string; token?: string; type?: string };
      identifier: string;
      serverUrl?: string;
      transport: 'http' | 'stdio';
    }) => {
      try {
        if (!capabilities.canCreateConnector) throw new Error(LOCAL_ERROR.PERMISSION);
        if (values.transport !== 'http' || !values.serverUrl) {
          throw new Error(LOCAL_ERROR.CONNECTOR_HTTP_ONLY);
        }
        if (values.auth?.type === 'oauth2') {
          throw new Error(LOCAL_ERROR.CONNECTOR_OAUTH_VIA_ADVANCED);
        }
        const key = values.identifier
          .toLowerCase()
          .replaceAll(/[^a-z0-9._-]+/g, '-')
          .replaceAll(/^[^a-z0-9]+|[-._]+$/g, '');
        if (!key) throw new Error(LOCAL_ERROR.CONNECTOR_IDENTIFIER_INVALID);

        const base = {
          displayName: values.identifier,
          enabled: true,
          endpoint: values.serverUrl,
          key,
          reason: REASONS.connectorCreate,
          transport: 'http' as const,
        };
        const token = values.auth?.type === 'bearer' ? values.auth?.token?.trim() : undefined;
        const created = token
          ? await adminConnectorsService.applyImmediate({
              ...base,
              credentialMode: 'shared_service_account',
              mode: 'create',
              sharedSecret: { operation: 'replace', value: { bearerToken: token } },
            })
          : await adminConnectorsService.applyImmediate({
              ...base,
              credentialMode: 'none',
              mode: 'create',
            });

        // Soft publish failure on create: draft exists but is not live.
        if (created.published === false) {
          toast.warning(
            t('aiToolSettings.connectors.createIncomplete', {
              defaultValue:
                'Connector draft was created, but discovery or publish did not complete. Finish setup in the advanced catalog.',
            }),
          );
          retry();
          // Reject so the create modal does not treat this as full success (AI-06).
          throw new Error(LOCAL_ERROR.CREATE_INCOMPLETE);
        }

        // Parity with the user flow (create → tool sync): probe the endpoint and
        // publish the discovered tool list, defaulting every tool to allowed.
        try {
          const discovered = await adminConnectorsService.discover({
            id: created.draft.id,
            reason: REASONS.connectorDiscover,
          });
          if (discovered.tools.length > 0) {
            const detail = await adminConnectorsService.get({ id: created.draft.id });
            const toolsUpdate = await adminConnectorsService.applyImmediate({
              expectedDraftToken: detail.draftToken,
              expectedRevision: detail.baseRevision,
              id: created.draft.id,
              mode: 'update',
              reason: REASONS.connectorCreate,
              tools: discovered.tools.map((tool, index) => ({
                ...tool,
                id: `${key}-${index}`,
                platformPolicy: 'allow' as const,
                requiresConfirmation: false,
              })),
            });
            if (toolsUpdate.published === false) {
              toast.warning(
                t('aiToolSettings.connectors.createIncomplete', {
                  defaultValue:
                    'Connector draft was created, but discovery or publish did not complete. Finish setup in the advanced catalog.',
                }),
              );
              retry();
              throw new Error(LOCAL_ERROR.CREATE_INCOMPLETE);
            }
          }
        } catch (discoverErr) {
          if (isPartialCreateMarker(discoverErr)) {
            throw discoverErr;
          }
          // Endpoint unreachable: draft stays; surface partial success and keep modal open.
          toast.warning(
            t('connectorCatalog.toast.createdDiscoveryFailed', {
              defaultValue:
                'Connector created, but tool discovery failed. Open the advanced catalog to retry discovery.',
            }),
          );
          retry();
          throw new Error(LOCAL_ERROR.CREATE_DISCOVERY_FAILED, { cause: discoverErr });
        }
        toast.success(t('connectorCatalog.toast.created'));
        retry();
      } catch (err) {
        // Partial-success paths already toasted a warning and rethrew a typed marker.
        // Hard applyImmediate failures are toasted by withAdminAiInfraErrorToast.
        // Local precondition failures need a generic connector toast.
        if (isLocalAdapterError(err)) notifyConnectorFailure();
        throw err;
      }
    },
    [capabilities.canCreateConnector, notifyConnectorFailure, retry, t],
  );

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
  };
};
