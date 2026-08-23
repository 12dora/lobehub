import type { PlatformUserConnectorBindingItem } from '@/database/schemas/platform/connectors';

import type { ConnectorCatalogSecretStore } from './catalogTypes';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import type {
  ConnectorOperationProof,
  ConnectorOperationSnapshotService,
} from './operationSnapshot';
import type { ConnectorRuntimeExecutionJournal } from './runtimeExecutionJournal';

export interface ConnectorRuntimePolicyRecord {
  agentAllowed: boolean;
  legacyRequiresConfirmation?: boolean;
  userEnabled: boolean;
}

export interface ConnectorRuntimePolicyResolver {
  resolve: (params: {
    agentId: string;
    connectorId: string;
    connectorKey: string;
    toolKey: string;
    userId: string;
  }) => Promise<ConnectorRuntimePolicyRecord>;
}

export interface ConnectorRuntimeAuditWriter {
  appendSharedCall: (params: {
    connectorId: string;
    idempotencyKey?: string;
    operationId: string;
    outcome: 'admitted' | 'allowed' | 'denied' | 'failed' | 'rate_limited' | 'unknown';
    toolKey: string;
    userId: string;
  }) => Promise<void>;
}

export interface ConnectorRuntimeRateLimiter {
  consume: (scope: string) => boolean | Promise<boolean>;
}

export interface PlatformConnectorRuntimeAdapterDependencies {
  assertCurrentPublished?: () => Promise<void>;
  audit: ConnectorRuntimeAuditWriter;
  bindingLoader: (
    userId: string,
    connectorId: string,
  ) => Promise<PlatformUserConnectorBindingItem | undefined>;
  clock?: () => Date;
  journal: ConnectorRuntimeExecutionJournal;
  outbound: Pick<ConnectorOutboundClient, 'preflight' | 'requestJson'>;
  policy: ConnectorRuntimePolicyResolver;
  rateLimiter: ConnectorRuntimeRateLimiter;
  refreshBinding?: (
    userId: string,
    connectorId: string,
    publishedRevision: number,
  ) => Promise<void>;
  secrets: ConnectorCatalogSecretStore;
  snapshots: Pick<ConnectorOperationSnapshotService, 'resolveExact'>;
}

export interface PlatformConnectorRuntimeInvocation {
  agentId: string;
  arguments: string | Record<string, unknown>;
  /**
   * Org connector-governance shared OAuth identity: when set, the
   * per_user_oauth binding is loaded and refreshed for THIS user id (the
   * governance-designated shared auth owner) instead of the invoking
   * `userId`, so every user runs on the owner's authorization. The binding
   * ownership guard then compares against this effective identity — it still
   * fails closed on any binding belonging to a third identity. Absent →
   * per-user behavior, byte-identical to today. Audit / journal records keep
   * the invoking `userId` (the actual actor).
   */
  effectiveBindingUserId?: string;
  humanApproved: boolean;
  proof: ConnectorOperationProof;
  toolCallId: string;
  toolKey: string;
  userId: string;
}

export interface PlatformConnectorRuntimeResult {
  confirmation: 'always' | null;
  content: string;
  state?: Record<string, unknown>;
  success: true;
}
