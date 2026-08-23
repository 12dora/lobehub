import type { PlatformConnectorRevisionPayload } from '@/database/repositories/platformConnectorCatalog';

import type { ConnectorResolvedSecret } from './catalogTypes';
import type { ConnectorSecretCleanupRef } from './secretCleanup';

export interface ConnectorPublicationProof {
  afterDiff: Record<string, unknown>;
  cleanupRefs: ConnectorSecretCleanupRef[];
  draftToken: string;
  endpoint: string;
  payload: PlatformConnectorRevisionPayload;
  payloadChecksum: string;
  policyVersion: number | string | null;
  resolved: {
    oauth: ConnectorResolvedSecret | null;
    shared: ConnectorResolvedSecret | null;
  };
  secretFingerprint: string | null;
  targetRevision: number | null;
}

export const EMERGENCY_STOP_AUDIT_REASON = 'emergency_connector_stop';
export const MAX_REVOKE_BINDINGS = 10_000;
export const MAX_REVOKE_PAGES = 100;
export const REVOKE_PAGE_SIZE = 100;
