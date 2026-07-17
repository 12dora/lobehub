import type { AdminConnectorListInput } from './types';

export const ADMIN_CONNECTOR_LIST_KEY = 'adminConnector.list';
export const ADMIN_CONNECTOR_GET_KEY = 'adminConnector.get';
export const ADMIN_CONNECTOR_AUDIT_KEY = 'admin.audit.list.connector';

export const buildAdminConnectorListKey = (input: AdminConnectorListInput, enabled: boolean) =>
  enabled
    ? [
        ADMIN_CONNECTOR_LIST_KEY,
        input.cursor ?? null,
        input.credentialMode ?? null,
        input.enabled ?? null,
        input.limit,
        input.query ?? null,
        input.status ?? null,
      ]
    : null;

export const buildAdminConnectorGetKey = (id: string | undefined, enabled: boolean) =>
  enabled && id ? [ADMIN_CONNECTOR_GET_KEY, id] : null;

export const buildAdminConnectorAuditKey = (params: {
  connectorId: string;
  cursor?: string | null;
  enabled: boolean;
  limit?: number;
}) =>
  params.enabled
    ? [ADMIN_CONNECTOR_AUDIT_KEY, params.connectorId, params.cursor ?? null, params.limit ?? 50]
    : null;
