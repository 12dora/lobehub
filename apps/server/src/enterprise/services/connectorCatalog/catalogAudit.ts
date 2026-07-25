import type { LobeChatDatabase } from '@/database/type';

import {
  collectConnectorSecretLeaves,
  type ConnectorCurrentSecretLoader,
} from '../../contracts/platformConnectors';
import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import type { ConnectorDraft } from './catalogTypes';
import { PlatformConnectorContractError } from './errors';
import { assertConnectorPersistentTextSafe } from './secretBoundary';

const MAX_CONNECTOR_AUDIT_DIFF_BYTES = 4096;
const MAX_CHANGED_KEYS = 32;

export const throwStableConnectorSecretError = (error: unknown): never => {
  if (error instanceof PlatformConnectorContractError) throw error;
  throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
};

export const loadConnectorSecretSourcesSafe = async (
  secrets: ConnectorCurrentSecretLoader,
  connectorId: string,
) => {
  try {
    return await secrets.loadCurrentSecretSources(connectorId);
  } catch (error) {
    return throwStableConnectorSecretError(error);
  }
};

export const sanitizeConnectorReason = async (
  secrets: ConnectorCurrentSecretLoader,
  connectorId: string,
  reason: string,
): Promise<string> => {
  const sources = await loadConnectorSecretSourcesSafe(secrets, connectorId);
  return assertConnectorPersistentTextSafe(
    reason,
    collectConnectorSecretLeaves(sources.oauthClientSecret, sources.sharedSecret),
  );
};

export const connectorAuditSummary = (
  draft: ConnectorDraft,
  changedKeys: string[] = [],
): Record<string, unknown> => {
  const summary = {
    changedKeys: [...new Set(changedKeys)].sort().slice(0, MAX_CHANGED_KEYS),
    connectorId: draft.id,
    key: draft.key,
    mode: draft.credentialMode,
    oauthSlot: {
      configured: draft.oauthClientSecret.configured,
      fingerprint: draft.oauthClientSecret.fingerprint,
    },
    revision: draft.revision,
    sharedSlot: {
      configured: draft.sharedSecret.configured,
      fingerprint: draft.sharedSecret.fingerprint,
    },
    status: draft.status,
    toolCount: draft.tools.length,
  };
  if (
    new TextEncoder().encode(JSON.stringify(summary)).byteLength > MAX_CONNECTOR_AUDIT_DIFF_BYTES
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  }
  return summary;
};

export interface ConnectorFailureAuditParams {
  action: AuditAction;
  actorUserId: string;
  reason?: string | null;
  targetId?: string | null;
}

export type ConnectorFailureAuditWriter = (
  db: LobeChatDatabase,
  params: ConnectorFailureAuditParams,
) => Promise<void>;

const defaultFailureAuditWriter: ConnectorFailureAuditWriter = async (db, params) => {
  await new PlatformAuditService(db).append({
    action: params.action,
    actorUserId: params.actorUserId,
    reason: params.reason ?? null,
    result: 'failure',
    targetId: params.targetId ?? null,
    targetType: 'connector',
  });
};

export const appendConnectorFailureAudit = async (
  db: LobeChatDatabase,
  params: ConnectorFailureAuditParams,
  writer: ConnectorFailureAuditWriter = defaultFailureAuditWriter,
): Promise<void> => {
  try {
    await writer(db, params);
  } catch (error) {
    console.error('[connectorCatalog] failure audit unavailable', {
      action: params.action,
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      targetId: params.targetId ?? null,
    });
  }
};
