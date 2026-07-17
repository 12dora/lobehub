import type { ToolManifest } from '@lobechat/types';

import { ConnectorModel } from '@/database/models/connector';
import { ConnectorToolModel } from '@/database/models/connectorTool';
import {
  PlatformConnectorCatalogRepository,
  PlatformUserConnectorBindingRepository,
} from '@/database/repositories/platformConnectorCatalog';
import { ConnectorToolPermission } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretService } from '../../security/secret';
import { PlatformAuditService } from '../platformAudit';
import { ConnectorOutboundClient } from './connectorOutboundClient';
import { PlatformConnectorContractError } from './errors';
import { type ConnectorOAuthRuntimeEnv, getConnectorOAuthRuntime } from './oauthRuntime';
import {
  type ConnectorApprovalReceipt,
  ConnectorOperationProofSigner,
  type ConnectorOwnedOperationProof,
  fingerprintConnectorAgentPolicy,
  toConnectorOperationProof,
} from './operationProofSigner';
import { ConnectorOperationSnapshotService } from './operationSnapshot';
import { PlatformConnectorSecretStore } from './platformConnectorSecretStore';
import { getConnectorPublishedIndex } from './publishedIndex';
import { PlatformConnectorRuntimeAdapter } from './runtimeAdapter';
import {
  type ConnectorRuntimeEffectiveMode,
  getConnectorRuntimeEffectiveState,
} from './runtimeEffectiveState';
import { createSharedRateLimiter } from './sharedRateLimiter';
import { resolveConnectorConfirmationPolicy } from './toolPolicy';
import { UserConnectorOAuthService } from './userOAuthService';

export interface PlatformConnectorRuntimeManifest extends ToolManifest {
  platformConnectorAgentPolicy: { connectorKeys: string[]; revision: number };
  platformConnectorProof?: ConnectorOwnedOperationProof;
  platformConnectorTombstone?: boolean;
}

export interface ManagedConnectorExecutionResult {
  handled: boolean;
  result?: {
    content: string;
    error?: { code: string; message: string };
    state?: Record<string, unknown>;
    success: boolean;
  };
}

const snapshotsByDatabase = new WeakMap<object, ConnectorOperationSnapshotService>();

const getSnapshots = (db: LobeChatDatabase): ConnectorOperationSnapshotService => {
  const key = db as object;
  const existing = snapshotsByDatabase.get(key);
  if (existing) return existing;
  const created = new ConnectorOperationSnapshotService(new PlatformConnectorCatalogRepository(db));
  snapshotsByDatabase.set(key, created);
  return created;
};

const stableFailure = (code: string): ManagedConnectorExecutionResult => ({
  handled: true,
  result: { content: code, error: { code, message: code }, success: false },
});

export const createConnectorApprovalReceipt = (params: {
  agentId: string;
  env?: ConnectorOAuthRuntimeEnv;
  identifier: string;
  manifest: unknown;
  operationId: string;
  toolCallId: string;
  userId: string;
}): ConnectorApprovalReceipt | undefined => {
  const manifest = params.manifest as Partial<PlatformConnectorRuntimeManifest> | undefined;
  if (!manifest?.platformConnectorProof) return;
  const signer = new ConnectorOperationProofSigner(params.env ?? process.env);
  const proof = signer.verifyProof(manifest.platformConnectorProof);
  if (
    proof.operationId !== params.operationId ||
    proof.agentId !== params.agentId ||
    proof.userId !== params.userId ||
    proof.connectorKey !== params.identifier
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
  }
  if (!manifest.platformConnectorAgentPolicy) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
  }
  return signer.signApprovalReceipt(
    proof,
    manifest.platformConnectorAgentPolicy,
    params.toolCallId,
  );
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

export const buildManagedConnectorManifests = async (params: {
  approvedReceipt?: ConnectorApprovalReceipt;
  connectorKeys: string[];
  agentId: string;
  db: LobeChatDatabase;
  env?: ConnectorOAuthRuntimeEnv;
  operationId: string;
  userId: string;
  workspaceId?: string;
}): Promise<{
  manifests: PlatformConnectorRuntimeManifest[];
  mode: ConnectorRuntimeEffectiveMode;
}> => {
  const effectiveState = await getConnectorRuntimeEffectiveState(params.env ?? process.env);
  const mode = effectiveState.mode;
  if (mode !== 'enforced') return { manifests: [], mode };

  const connectorKeys = [...new Set(params.connectorKeys)].sort();
  const agentPolicy = { connectorKeys, revision: effectiveState.revision };
  const agentPolicyFingerprint = fingerprintConnectorAgentPolicy({
    agentId: params.agentId,
    connectorKeys,
    managedPolicyRevision: effectiveState.revision,
  });
  const signer = new ConnectorOperationProofSigner(params.env ?? process.env);
  const approvedReceipt = params.approvedReceipt
    ? signer.verifyApprovalReceipt(params.approvedReceipt)
    : undefined;
  if (
    approvedReceipt &&
    (approvedReceipt.proof.userId !== params.userId ||
      approvedReceipt.proof.agentId !== params.agentId ||
      !approvedReceipt.agentPolicy.connectorKeys.includes(approvedReceipt.proof.connectorKey) ||
      fingerprintConnectorAgentPolicy({
        agentId: params.agentId,
        connectorKeys: approvedReceipt.agentPolicy.connectorKeys,
        managedPolicyRevision: approvedReceipt.agentPolicy.revision,
      }) !== approvedReceipt.proof.agentPolicyFingerprint)
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
  }
  const legacyConnectors = await new ConnectorModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryByIdentifiers(params.connectorKeys);
  const legacyByKey = new Map(
    legacyConnectors.map((connector) => [connector.identifier, connector]),
  );
  const legacyTools = await new ConnectorToolModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryAllByConnectorIds(legacyConnectors.map((connector) => connector.id));
  const legacyToolsByConnector = new Map<string, typeof legacyTools>();
  for (const tool of legacyTools) {
    const current = legacyToolsByConnector.get(tool.userConnectorId) ?? [];
    current.push(tool);
    legacyToolsByConnector.set(tool.userConnectorId, current);
  }

  const manifests: PlatformConnectorRuntimeManifest[] = [];
  for (const connectorKey of connectorKeys) {
    if (approvedReceipt?.proof.connectorKey === connectorKey) {
      const exact = await getSnapshots(params.db).resolveExact(
        toConnectorOperationProof(approvedReceipt.proof),
      );
      const permissionByTool = new Map<string, string>();
      const legacyConnector = legacyByKey.get(connectorKey);
      for (const tool of legacyConnector
        ? (legacyToolsByConnector.get(legacyConnector.id) ?? [])
        : []) {
        permissionByTool.set(tool.toolName, tool.permission);
      }
      manifests.push(
        buildPublishedManifest({
          agentPolicy: approvedReceipt.agentPolicy,
          connectorKey,
          permissionByTool,
          proof: approvedReceipt.proof,
          snapshot: exact,
        }),
      );
      continue;
    }
    const indexed = await getConnectorPublishedIndex(params.db).resolveCurrent({
      connectorKey,
      operationId: params.operationId,
    });
    if (indexed.kind === 'unknown') continue;
    if (indexed.kind === 'tombstone') {
      manifests.push({
        api: [],
        identifier: connectorKey,
        meta: { description: 'Managed Connector is unavailable', title: connectorKey },
        platformConnectorAgentPolicy: agentPolicy,
        platformConnectorTombstone: true,
        type: 'mcp',
      });
      continue;
    }
    const snapshot = indexed.snapshot;
    const legacyConnector = legacyByKey.get(connectorKey);
    const permissionByTool = new Map(
      (legacyConnector ? (legacyToolsByConnector.get(legacyConnector.id) ?? []) : []).map(
        (tool) => [tool.toolName, tool.permission],
      ),
    );
    manifests.push(
      buildPublishedManifest({
        agentPolicy,
        connectorKey,
        permissionByTool,
        proof: signer.signProof({
          agentId: params.agentId,
          agentPolicyFingerprint,
          managedPolicyRevision: effectiveState.revision,
          proof: snapshot.proof,
          userId: params.userId,
        }),
        snapshot,
      }),
    );
  }
  return { manifests, mode };
};

const buildPublishedManifest = (params: {
  agentPolicy: PlatformConnectorRuntimeManifest['platformConnectorAgentPolicy'];
  connectorKey: string;
  permissionByTool: Map<string, string>;
  proof: ConnectorOwnedOperationProof;
  snapshot: Awaited<ReturnType<ConnectorOperationSnapshotService['resolveExact']>>;
}): PlatformConnectorRuntimeManifest => ({
  api: params.snapshot.payload.tools
    .filter((tool) => tool.platformPolicy === 'allow')
    .filter(
      (tool) => params.permissionByTool.get(tool.toolKey) !== ConnectorToolPermission.disabled,
    )
    .map((tool) => {
      const humanIntervention = resolveConnectorConfirmationPolicy({
        legacyRequiresConfirmation:
          params.permissionByTool.get(tool.toolKey) === ConnectorToolPermission.needs_approval,
        requiresConfirmation: tool.requiresConfirmation,
        riskLevel: tool.riskLevel,
      });
      return {
        description: tool.description ?? '',
        ...(humanIntervention ? { humanIntervention } : {}),
        name: tool.toolKey,
        parameters: tool.inputSchema,
      };
    }),
  identifier: params.connectorKey,
  meta: {
    avatar: 'MCP_AVATAR',
    description: params.snapshot.payload.connector.description ?? undefined,
    title: params.snapshot.payload.connector.displayName,
  },
  platformConnectorAgentPolicy: params.agentPolicy,
  platformConnectorProof: params.proof,
  type: 'mcp',
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
  userId?: string;
  workspaceId?: string;
}): Promise<ManagedConnectorExecutionResult> => {
  const flags = parseEnterpriseFeatureFlags(params.env ?? process.env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS || !params.db) return { handled: false };

  try {
    const mode = await resolveConnectorRuntimeMode({ env: params.env });
    if (mode === 'legacy') return { handled: false };
    if (mode === 'blocked') return stableFailure('PLATFORM_CONNECTOR_NOT_PUBLISHED');

    if (!params.userId || !params.agentId || !params.operationId || !params.toolCallId) {
      return stableFailure('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
    const manifest = params.manifest as Partial<PlatformConnectorRuntimeManifest> | undefined;
    if (manifest?.platformConnectorTombstone) {
      return stableFailure('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const signer = new ConnectorOperationProofSigner(params.env ?? process.env);
    const proof = signer.verifyProof(manifest?.platformConnectorProof);
    const agentPolicy = manifest?.platformConnectorAgentPolicy;
    const agentPolicyAllowed =
      proof.agentId === params.agentId &&
      proof.userId === params.userId &&
      proof.connectorKey === params.identifier &&
      agentPolicy?.revision === proof.managedPolicyRevision &&
      agentPolicy.connectorKeys.includes(proof.connectorKey) &&
      fingerprintConnectorAgentPolicy({
        agentId: params.agentId,
        connectorKeys: agentPolicy.connectorKeys,
        managedPolicyRevision: agentPolicy.revision,
      }) === proof.agentPolicyFingerprint;
    if (!agentPolicyAllowed) return stableFailure('PLATFORM_CONNECTOR_TOOL_DENIED');

    let humanApproved = false;
    if (proof.operationId !== params.operationId) {
      const receipt = signer.verifyApprovalReceipt(params.approvalReceipt);
      humanApproved =
        receipt.toolCallId === params.toolCallId &&
        receipt.proof.signature === proof.signature &&
        receipt.proof.operationId === proof.operationId &&
        receipt.proof.userId === params.userId &&
        receipt.proof.agentId === params.agentId;
      if (!humanApproved) return stableFailure('PLATFORM_CONNECTOR_TOOL_DENIED');
    } else if (params.approvalReceipt) {
      const receipt = signer.verifyApprovalReceipt(params.approvalReceipt);
      humanApproved =
        receipt.toolCallId === params.toolCallId && receipt.proof.signature === proof.signature;
    }

    const snapshots = getSnapshots(params.db);
    const secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise(
      params.env ?? process.env,
      flags,
    );
    if (!secretService) return stableFailure('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    const secrets = new PlatformConnectorSecretStore(params.db, secretService);
    const outbound = new ConnectorOutboundClient(new SafeOutboundHttpClient());
    const adapter = new PlatformConnectorRuntimeAdapter({
      audit: {
        appendSharedCall: async (entry) => {
          await new PlatformAuditService(params.db!).append({
            action: 'connector.runtime.sharedCall',
            actorUserId: entry.userId,
            afterDiff: {
              connectorId: entry.connectorId,
              operationId: entry.operationId,
              outcome: entry.outcome,
              toolKey: entry.toolKey,
            },
            reason: null,
            result:
              entry.outcome === 'allowed' || entry.outcome === 'admitted'
                ? 'success'
                : entry.outcome === 'denied'
                  ? 'denied'
                  : 'failure',
            targetId: entry.connectorId,
            targetType: 'connector',
          });
        },
      },
      bindingLoader: (userId, connectorId) =>
        new PlatformUserConnectorBindingRepository(params.db!, userId).getBinding(connectorId),
      outbound,
      policy: {
        resolve: async ({ connectorKey, toolKey, userId }) => {
          const permission = await resolveLegacyPermission({
            connectorKey,
            db: params.db!,
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
        const runtime = getConnectorOAuthRuntime(params.db!, params.env ?? process.env);
        await new UserConnectorOAuthService(params.db!, userId, runtime).refreshBinding(
          connectorId,
          publishedRevision,
        );
      },
      secrets,
      snapshots,
    });
    const result = await adapter.execute({
      agentId: params.agentId,
      arguments: params.arguments,
      humanApproved,
      proof: toConnectorOperationProof(proof),
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

const resolveLegacyPermission = async (params: {
  connectorKey: string;
  db: LobeChatDatabase;
  toolKey: string;
  userId: string;
  workspaceId?: string;
}) => {
  const [connector] = await new ConnectorModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryByIdentifiers([params.connectorKey]);
  if (!connector) return null;
  const tools = await new ConnectorToolModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryByConnector(connector.id);
  return tools.find((tool) => tool.toolName === params.toolKey)?.permission ?? null;
};
