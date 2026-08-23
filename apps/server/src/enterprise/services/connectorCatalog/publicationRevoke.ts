import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import type { Transaction } from '@/database/type';

import { sanitizeConnectorReason } from './catalogAudit';
import type { ConnectorCatalogLifecycle, ConnectorCatalogSecretStore } from './catalogTypes';
import { PlatformConnectorContractError } from './errors';
import {
  EMERGENCY_STOP_AUDIT_REASON,
  MAX_REVOKE_BINDINGS,
  MAX_REVOKE_PAGES,
  REVOKE_PAGE_SIZE,
} from './publicationProof';
import type { ConnectorSecretCleanupRef } from './secretCleanup';

export const sanitizeEmergencyReason = async (
  secrets: ConnectorCatalogSecretStore,
  connectorId: string,
  reason: string | null | undefined,
): Promise<string | null> => {
  try {
    return await sanitizeConnectorReason(secrets, connectorId, reason);
  } catch (error) {
    console.error('[connectorCatalog] emergency reason sanitization unavailable', {
      connectorId,
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    return EMERGENCY_STOP_AUDIT_REASON;
  }
};

export const revokeConnectorBindings = async (
  tx: Transaction,
  connectorId: string,
  lifecycle: ConnectorCatalogLifecycle,
): Promise<{ cleanupRefs: ConnectorSecretCleanupRef[]; revoked: number }> => {
  const repository = new PlatformConnectorCatalogRepository(tx);
  const cleanupRefs: ConnectorSecretCleanupRef[] = [];
  let cursor: string | undefined;
  let revoked = 0;
  const seenCursors = new Set<string>();
  for (let pageIndex = 0; pageIndex < MAX_REVOKE_PAGES; pageIndex += 1) {
    const page = await repository.revokeAllBindingsPage({
      afterId: cursor,
      connectorId,
      limit: REVOKE_PAGE_SIZE,
    });
    revoked += page.revoked;
    cleanupRefs.push(
      ...page.tokenRefs.map((ref) => ({ connectorId, ref, slot: 'oauthBindingToken' as const })),
      ...page.pkceVerifierRefs.map((ref) => ({
        connectorId,
        ref,
        slot: 'oauthPkceVerifier' as const,
      })),
    );
    if (revoked > MAX_REVOKE_BINDINGS) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
    }
    const nextCursor = page.nextCursor ?? undefined;
    if (!nextCursor) {
      await lifecycle.afterRevokeAll?.(connectorId, tx);
      return { cleanupRefs, revoked };
    }
    if (nextCursor === cursor || seenCursors.has(nextCursor)) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
};
