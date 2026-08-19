import type { ToolManifest } from '@lobechat/types';

import { PlatformUserConnectorBindingRepository } from '@/database/repositories/platformConnectorCatalog';
import { ConnectorToolPermission } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretService } from '../../security/secret';
import { createEgressSafeOutboundTransport } from '../networkProxy/egress/safeOutboundTransport';
import { PlatformAuditService } from '../platformAudit';
import { ConnectorOutboundClient } from './connectorOutboundClient';
import { connectorOutboundPolicyProvider } from './connectorOutboundPolicy';
import { PlatformConnectorContractError } from './errors';
import { resolveLegacyPermission } from './legacyToolPermissionOverlay';
import { type ConnectorOAuthRuntimeEnv, getConnectorOAuthRuntime } from './oauthRuntime';
import {
  type ConnectorOwnedOperationProof,
  toConnectorOperationProof,
} from './operationProofSigner';
import type { ConnectorOperationSnapshotService } from './operationSnapshot';
import { PlatformConnectorSecretStore } from './platformConnectorSecretStore';
import { getConnectorPublishedIndex } from './publishedIndex';
import { PlatformConnectorRuntimeAdapter } from './runtimeAdapter';
import { admitManagedConnectorExecution } from './runtimeAdmission';
import { appendConnectorRuntimeAudit } from './runtimeAudit';
import type { ConnectorRuntimeEffectiveMode } from './runtimeEffectiveState';
import { DatabaseConnectorRuntimeExecutionJournal } from './runtimeExecutionJournal';
import { getSnapshots } from './runtimeManifests';
import { resolveConnectorRuntimeMode } from './runtimeMode';
import { createSharedRateLimiter } from './sharedRateLimiter';
import { UserConnectorOAuthService } from './userOAuthService';

export type { PlatformConnectorRuntimeManifest } from './runtimeManifests';
export {
  buildManagedConnectorManifests,
  buildPinnedManagedConnectorManifests,
} from './runtimeManifests';
export { resolveConnectorRuntimeMode };
export {
  createConnectorApprovalReceipt,
  matchesConnectorApprovalReceipt,
  matchesConnectorDependencySelection,
} from './runtimeProofMatchers';

export interface ManagedConnectorExecutionResult {
  handled: boolean;
  result?: {
    content: string;
    error?: { code: string; message: string };
    state?: Record<string, unknown>;
    success: boolean;
  };
}

const stableFailure = (code: string): ManagedConnectorExecutionResult => {
  return {
    handled: true,
    result: {
      // The stable code stays machine-readable on `error.code`; user-facing
      // tool cards localize it at the presentation boundary.
      content: '',
      error: { code, message: '' },
      success: false,
    },
  };
};

/** Prevent direct legacy MCP routes from bypassing the operation snapshot executor. */
export const assertLegacyConnectorRuntimeAllowed = async (params: {
  env?: ConnectorOAuthRuntimeEnv;
  resolveState?: () => Promise<{ mode: ConnectorRuntimeEffectiveMode; revision: number }>;
}): Promise<void> => {
  const mode = await resolveConnectorRuntimeMode(params);
  if (mode === 'legacy') return;
  throw new PlatformConnectorContractError(
    mode === 'blocked' ? 'PLATFORM_CONNECTOR_NOT_PUBLISHED' : 'PLATFORM_CONNECTOR_TOOL_DENIED',
  );
};

const buildConnectorRuntimeAdapter = (
  params: {
    db: LobeChatDatabase;
    env?: ConnectorOAuthRuntimeEnv;
    workspaceId?: string;
  },
  proof: ConnectorOwnedOperationProof,
  agentPolicyAllowed: boolean,
  deps: {
    outbound: ConnectorOutboundClient;
    secrets: PlatformConnectorSecretStore;
    snapshots: ConnectorOperationSnapshotService;
  },
) =>
  new PlatformConnectorRuntimeAdapter({
    assertCurrentPublished: async () => {
      const current = await getConnectorPublishedIndex(params.db).resolveCurrent({
        connectorKey: proof.connectorKey,
        operationId: proof.operationId,
      });
      if (
        current.kind !== 'published' ||
        current.snapshot.proof.connectorId !== proof.connectorId
      ) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
      }
    },
    audit: {
      appendSharedCall: async (entry) =>
        entry.idempotencyKey
          ? appendConnectorRuntimeAudit(params.db, {
              ...entry,
              idempotencyKey: entry.idempotencyKey,
              outcome: entry.outcome === 'allowed' ? 'allowed' : 'unknown',
            })
          : new PlatformAuditService(params.db)
              .append({
                action: 'connector.runtime.sharedCall',
                actorUserId: entry.userId,
                afterDiff: entry,
                reason: null,
                result:
                  entry.outcome === 'admitted'
                    ? 'success'
                    : entry.outcome === 'denied'
                      ? 'denied'
                      : 'failure',
                targetId: entry.connectorId,
                targetType: 'connector',
              })
              .then(() => undefined),
    },
    bindingLoader: (userId, connectorId) =>
      new PlatformUserConnectorBindingRepository(params.db, userId).getBinding(connectorId),
    journal: new DatabaseConnectorRuntimeExecutionJournal(params.db),
    outbound: deps.outbound,
    policy: {
      resolve: async ({ connectorKey, toolKey, userId }) => {
        const permission = await resolveLegacyPermission({
          connectorKey,
          db: params.db,
          toolKey,
          userId,
          workspaceId: params.workspaceId,
        });
        return {
          agentAllowed: agentPolicyAllowed,
          legacyRequiresConfirmation: permission === ConnectorToolPermission.needs_approval,
          userEnabled: permission !== ConnectorToolPermission.disabled,
        };
      },
    },
    rateLimiter: createSharedRateLimiter(),
    refreshBinding: async (userId, connectorId, publishedRevision) => {
      const runtime = getConnectorOAuthRuntime(params.db, params.env ?? process.env);
      await new UserConnectorOAuthService(params.db, userId, runtime).refreshBinding(
        connectorId,
        publishedRevision,
      );
    },
    secrets: deps.secrets,
    snapshots: deps.snapshots,
  });

export const executeManagedConnectorTool = async (params: {
  agentId?: string;
  apiName: string;
  approvalReceipt?: unknown;
  arguments: string | Record<string, unknown>;
  db?: LobeChatDatabase;
  env?: ConnectorOAuthRuntimeEnv;
  identifier: string;
  manifest?: ToolManifest;
  operationId?: string;
  toolCallId?: string;
  toolType?: string;
  userId?: string;
  workspaceId?: string;
}): Promise<ManagedConnectorExecutionResult> => {
  try {
    const admission = await admitManagedConnectorExecution(params);
    if (admission.kind === 'bypass') return { handled: false };
    if (admission.kind === 'deny') return stableFailure(admission.code);

    const flags = parseEnterpriseFeatureFlags(params.env ?? process.env);
    const db = params.db;
    if (!db) return { handled: false };
    const snapshots = getSnapshots(db);
    const secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise(
      params.env ?? process.env,
      flags,
    );
    if (!secretService) return stableFailure('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    const secrets = new PlatformConnectorSecretStore(db, secretService);
    const outbound = new ConnectorOutboundClient(
      new SafeOutboundHttpClient({
        policyProvider: connectorOutboundPolicyProvider,
        ...createEgressSafeOutboundTransport('feature:mcp'),
      }),
    );
    const adapter = buildConnectorRuntimeAdapter(
      { db, env: params.env, workspaceId: params.workspaceId },
      admission.proof,
      true,
      { outbound, secrets, snapshots },
    );
    const result = await adapter.execute({
      agentId: admission.agentId,
      arguments: admission.arguments,
      // Shared-auth owner binding identity (see governance resolution above);
      // undefined keeps the per-user binding path byte-identical to today.
      effectiveBindingUserId: admission.effectiveBindingUserId,
      humanApproved: admission.humanApproved,
      proof: toConnectorOperationProof(admission.proof),
      toolCallId: admission.toolCallId,
      toolKey: admission.apiName,
      userId: admission.userId,
    });
    return {
      handled: true,
      result: { content: result.content, state: result.state, success: true },
    };
  } catch (error) {
    const code =
      error instanceof PlatformConnectorContractError
        ? error.code
        : 'PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED';
    return stableFailure(code);
  }
};
