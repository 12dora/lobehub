import type { LobeChatDatabase } from '@/database/type';

import {
  collectConnectorSecretLeaves,
  type ConnectorCurrentSecretLoader,
} from '../../contracts/platformConnectors';
import { PlatformAuditService } from '../platformAudit';
import { assertConnectorPersistentTextSafe } from './secretBoundary';

export const sanitizeConnectorReason = async (
  secrets: ConnectorCurrentSecretLoader,
  connectorId: string,
  reason: string,
): Promise<string> => {
  const sources = await secrets.loadCurrentSecretSources(connectorId);
  return assertConnectorPersistentTextSafe(
    reason,
    collectConnectorSecretLeaves(sources.oauthClientSecret, sources.sharedSecret),
  );
};

export const appendConnectorFailureAudit = async (
  db: LobeChatDatabase,
  params: {
    action: string;
    actorUserId: string;
    reason?: string | null;
    targetId?: string | null;
  },
): Promise<void> => {
  await new PlatformAuditService(db).append({
    action: params.action,
    actorUserId: params.actorUserId,
    reason: params.reason ?? null,
    result: 'failure',
    targetId: params.targetId ?? null,
    targetType: 'connector',
  });
};
