import type { ToolManifest } from '@lobechat/types';

import { PlatformUserConnectorBindingRepository } from '@/database/repositories/platformConnectorCatalog';
import { ConnectorToolPermission } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretService } from '../../security/secret';
import { resolveConnectorGovernance } from '../connectorGovernance/resolve';
import { CONNECTOR_GOVERNANCE_DENY_SHARED_OWNER } from '../connectorGovernance/types';
import { PlatformAuditService } from '../platformAudit';
import { ConnectorOutboundClient } from './connectorOutboundClient';
import { connectorOutboundPolicyProvider } from './connectorOutboundPolicy';
import { PlatformConnectorContractError } from './errors';
import { resolveLegacyPermission } from './legacyToolPermissionOverlay';
import { type ConnectorOAuthRuntimeEnv, getConnectorOAuthRuntime } from './oauthRuntime';
import {
  ConnectorOperationProofSigner,
  type ConnectorOwnedOperationProof,
  fingerprintConnectorAgentPolicy,
  toConnectorOperationProof,
} from './operationProofSigner';
import type { ConnectorOperationSnapshotService } from './operationSnapshot';
import { PlatformConnectorSecretStore } from './platformConnectorSecretStore';
import { getConnectorPublishedIndex } from './publishedIndex';
import { PlatformConnectorRuntimeAdapter } from './runtimeAdapter';
import { appendConnectorRuntimeAudit } from './runtimeAudit';
import {
  type ConnectorRuntimeEffectiveMode,
  getConnectorRuntimeEffectiveState,
} from './runtimeEffectiveState';
import { DatabaseConnectorRuntimeExecutionJournal } from './runtimeExecutionJournal';
import { getSnapshots, type PlatformConnectorRuntimeManifest } from './runtimeManifests';
import {
  matchesConnectorApprovalReceipt,
  matchesConnectorDependencySelection,
} from './runtimeProofMatchers';
import { createSharedRateLimiter } from './sharedRateLimiter';
import { UserConnectorOAuthService } from './userOAuthService';

export type { PlatformConnectorRuntimeManifest } from './runtimeManifests';
export {
  buildManagedConnectorManifests,
  buildPinnedManagedConnectorManifests,
} from './runtimeManifests';
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

/** Feature-off and non-enforced modes preserve legacy behavior without catalog runtime I/O. */
export const resolveConnectorRuntimeMode = async (params: {
  env?: ConnectorOAuthRuntimeEnv;
  resolveState?: () => Promise<{ mode: ConnectorRuntimeEffectiveMode; revision: number }>;
}): Promise<ConnectorRuntimeEffectiveMode> => {
  const env = params.env ?? process.env;
  const flags = parseEnterpriseFeatureFlags(env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) return 'legacy';
  return (await (params.resolveState ?? (() => getConnectorRuntimeEffectiveState(env)))()).mode;
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
  const flags = parseEnterpriseFeatureFlags(params.env ?? process.env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS || !params.db) return { handled: false };

  try {
    const mode = await resolveConnectorRuntimeMode({ env: params.env });
    if (mode === 'legacy') return { handled: false };
    if (mode === 'blocked') return stableFailure('PLATFORM_CONNECTOR_NOT_PUBLISHED');

    if (
      !params.userId ||
      !params.agentId ||
      !params.operationId ||
      !params.toolCallId ||
      !params.toolType
    ) {
      return stableFailure('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
    const manifest = params.manifest as Partial<PlatformConnectorRuntimeManifest> | undefined;
    if (manifest?.platformConnectorTombstone) {
      return stableFailure('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const signer = new ConnectorOperationProofSigner(params.env ?? process.env);
    const proof = signer.verifyProof(manifest?.platformConnectorProof);
    const agentPolicy = manifest?.platformConnectorAgentPolicy;
    const selection = agentPolicy?.selections.find(
      (candidate) => candidate.connectorKey === params.identifier,
    );
    const agentPolicyAllowed =
      proof.agentId === params.agentId &&
      proof.userId === params.userId &&
      proof.connectorKey === params.identifier &&
      agentPolicy?.revision === proof.managedPolicyRevision &&
      matchesConnectorDependencySelection({ apiName: params.apiName, proof, selection }) &&
      fingerprintConnectorAgentPolicy({
        agentId: params.agentId,
        managedPolicyRevision: agentPolicy.revision,
        selections: agentPolicy.selections,
      }) === proof.agentPolicyFingerprint;
    if (!agentPolicyAllowed) return stableFailure('PLATFORM_CONNECTOR_TOOL_DENIED');

    if (proof.operationId !== params.operationId) {
      return stableFailure('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
    let humanApproved = false;
    if (params.approvalReceipt) {
      const receipt = signer.verifyApprovalReceipt(params.approvalReceipt);
      humanApproved = matchesConnectorApprovalReceipt({
        apiName: params.apiName,
        arguments: params.arguments,
        identifier: params.identifier,
        proof,
        receipt,
        toolCallId: params.toolCallId,
        toolType: params.toolType,
      });
    }

    // Org-wide shared OAuth identity (connector governance): while the
    // connectors managed policy is enforced with a designated owner,
    // per_user_oauth executions load/refresh the OWNER's platform binding so
    // every user shares that one authorization. Resolved once per execution.
    // Unresolvable governance returns DENIED_CONNECTOR_GOVERNANCE (active +
    // synthetic shared owner) — never fall back to the invoking user's binding.
    // User bindings are never written from here.
    const governance = await resolveConnectorGovernance(params.db);
    if (
      governance.active &&
      governance.sharedAuthOwnerUserId === CONNECTOR_GOVERNANCE_DENY_SHARED_OWNER
    ) {
      return stableFailure('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
    const effectiveBindingUserId =
      governance.active && governance.sharedAuthOwnerUserId
        ? governance.sharedAuthOwnerUserId
        : undefined;

    const snapshots = getSnapshots(params.db);
    const secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise(
      params.env ?? process.env,
      flags,
    );
    if (!secretService) return stableFailure('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    const secrets = new PlatformConnectorSecretStore(params.db, secretService);
    const outbound = new ConnectorOutboundClient(
      new SafeOutboundHttpClient({ policyProvider: connectorOutboundPolicyProvider }),
    );
    const adapter = buildConnectorRuntimeAdapter(
      { db: params.db, env: params.env, workspaceId: params.workspaceId },
      proof,
      agentPolicyAllowed,
      { outbound, secrets, snapshots },
    );
    const result = await adapter.execute({
      agentId: params.agentId,
      arguments: params.arguments,
      // Shared-auth owner binding identity (see governance resolution above);
      // undefined keeps the per-user binding path byte-identical to today.
      effectiveBindingUserId,
      humanApproved,
      proof: toConnectorOperationProof(proof),
      toolCallId: params.toolCallId,
      toolKey: params.apiName,
      userId: params.userId,
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
