import type { LobeChatDatabase } from '@/database/type';

import { PlatformAuditService } from '../platformAudit';
import type { ConnectorRuntimeAuditRecord } from './runtimeExecutionJournal';

export const appendConnectorRuntimeAudit = async (
  db: LobeChatDatabase,
  entry: ConnectorRuntimeAuditRecord,
): Promise<void> => {
  await new PlatformAuditService(db).append({
    action: 'connector.runtime.sharedCall',
    actorUserId: entry.userId,
    afterDiff: {
      connectorId: entry.connectorId,
      operationId: entry.operationId,
      outcome: entry.outcome,
      toolKey: entry.toolKey,
    },
    id: entry.idempotencyKey,
    reason: null,
    result: entry.outcome === 'allowed' ? 'success' : 'failure',
    targetId: entry.connectorId,
    targetType: 'connector',
  });
};
