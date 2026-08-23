'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import type { AdminToolScopeCapabilities } from '@/features/AdminToolScope';

import { BUILTIN_ROW_PREFIX, REASONS } from './adminToolScopeHelpers';
import { isLocalAdapterError, isPartialCreateMarker, LOCAL_ERROR } from './toolScopeErrors';
import type { AdminToolScopeSectionParams } from './toolScopeSection';
import type { useAdminConnectorCatalog } from './useAdminConnectorCatalog';

type ConnectorCatalog = ReturnType<typeof useAdminConnectorCatalog>;

export interface CustomConnectorFormValues {
  auth?: { clientId?: string; clientSecret?: string; token?: string; type?: string };
  identifier: string;
  serverUrl?: string;
  transport: 'http' | 'stdio';
}

interface UseAdminConnectorLifecycleParams {
  capabilities: AdminToolScopeCapabilities;
  connectorDetailById: ConnectorCatalog['connectorDetailById'];
  notifications: AdminToolScopeSectionParams['notifications'];
  retry: ConnectorCatalog['retry'];
}

/**
 * The quick-create form only covers what an immediate create can complete:
 * an HTTP endpoint with at most a bearer secret. OAuth needs the advanced
 * catalog flow.
 */
const toCreatableConnector = (
  values: CustomConnectorFormValues,
): { endpoint: string; key: string } => {
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
  return { endpoint: values.serverUrl, key };
};

const createConnectorRecord = async (
  values: CustomConnectorFormValues,
  { endpoint, key }: { endpoint: string; key: string },
) => {
  const base = {
    displayName: values.identifier,
    enabled: true,
    endpoint,
    key,
    reason: REASONS.connectorCreate,
    transport: 'http' as const,
  };
  const token = values.auth?.type === 'bearer' ? values.auth?.token?.trim() : undefined;
  return token
    ? adminConnectorsService.applyImmediate({
        ...base,
        credentialMode: 'shared_service_account',
        mode: 'create',
        sharedSecret: { operation: 'replace', value: { bearerToken: token } },
      })
    : adminConnectorsService.applyImmediate({
        ...base,
        credentialMode: 'none',
        mode: 'create',
      });
};

/**
 * Parity with the user flow (create → tool sync): probe the endpoint and
 * publish the discovered tool list, defaulting every tool to allowed.
 * Resolves `published: false` when the tool update stayed a draft.
 */
const publishDiscoveredTools = async (
  connectorId: string,
  key: string,
): Promise<{ published: boolean }> => {
  const discovered = await adminConnectorsService.discover({
    id: connectorId,
    reason: REASONS.connectorDiscover,
  });
  if (discovered.tools.length === 0) return { published: true };
  const detail = await adminConnectorsService.get({ id: connectorId });
  const toolsUpdate = await adminConnectorsService.applyImmediate({
    expectedDraftToken: detail.draftToken,
    expectedRevision: detail.baseRevision,
    id: connectorId,
    mode: 'update',
    reason: REASONS.connectorCreate,
    tools: discovered.tools.map((tool, index) => ({
      ...tool,
      id: `${key}-${index}`,
      platformPolicy: 'allow' as const,
      requiresConfirmation: false,
    })),
  });
  return { published: toolsUpdate.published !== false };
};

/** Create / delete of platform connectors from the parity settings UI. */
export const useAdminConnectorLifecycle = ({
  capabilities,
  connectorDetailById,
  notifications,
  retry,
}: UseAdminConnectorLifecycleParams) => {
  const { t } = useTranslation('admin');
  const { notifyConnectorFailure, notifyUnlessAlreadyToasted } = notifications;

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

  /** Draft exists but is not live — warn, refresh, and let the caller reject. */
  const notifyCreateIncomplete = useCallback(() => {
    toast.warning(
      t('aiToolSettings.connectors.createIncomplete', {
        defaultValue:
          'Connector draft was created, but discovery or publish did not complete. Finish setup in the advanced catalog.',
      }),
    );
    retry();
  }, [retry, t]);

  const submitCustomConnector = useCallback(
    async (values: CustomConnectorFormValues) => {
      try {
        if (!capabilities.canCreateConnector) throw new Error(LOCAL_ERROR.PERMISSION);
        const creatable = toCreatableConnector(values);
        const created = await createConnectorRecord(values, creatable);

        // Soft publish failure on create: draft exists but is not live.
        if (created.published === false) {
          notifyCreateIncomplete();
          // Reject so the create modal does not treat this as full success (AI-06).
          throw new Error(LOCAL_ERROR.CREATE_INCOMPLETE);
        }

        try {
          const toolsSync = await publishDiscoveredTools(created.draft.id, creatable.key);
          if (!toolsSync.published) {
            notifyCreateIncomplete();
            throw new Error(LOCAL_ERROR.CREATE_INCOMPLETE);
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
    [capabilities.canCreateConnector, notifyConnectorFailure, notifyCreateIncomplete, retry, t],
  );

  return { deleteConnector, submitCustomConnector };
};
