import type { PlatformAgentConnectorDependencyRef, ToolManifest } from '@lobechat/types';

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
import { resolveConnectorGovernance } from '../connectorGovernance/resolve';
import { CONNECTOR_GOVERNANCE_DENY_SHARED_OWNER } from '../connectorGovernance/types';
import { PlatformAuditService } from '../platformAudit';
import { ConnectorOutboundClient } from './connectorOutboundClient';
import { connectorOutboundPolicyProvider } from './connectorOutboundPolicy';
import { PlatformConnectorContractError } from './errors';
import { type ConnectorOAuthRuntimeEnv, getConnectorOAuthRuntime } from './oauthRuntime';
import {
  type ConnectorApprovalReceipt,
  type ConnectorDependencySelection,
  ConnectorOperationProofSigner,
  type ConnectorOwnedOperationProof,
  fingerprintConnectorAgentPolicy,
  fingerprintConnectorToolCall,
  toConnectorOperationProof,
} from './operationProofSigner';
import { ConnectorOperationSnapshotService } from './operationSnapshot';
import { PlatformConnectorSecretStore } from './platformConnectorSecretStore';
import { getConnectorPublishedIndex } from './publishedIndex';
import { PlatformConnectorRuntimeAdapter } from './runtimeAdapter';
import { appendConnectorRuntimeAudit } from './runtimeAudit';
import {
  type ConnectorRuntimeEffectiveMode,
  getConnectorRuntimeEffectiveState,
} from './runtimeEffectiveState';
import { DatabaseConnectorRuntimeExecutionJournal } from './runtimeExecutionJournal';
import { createSharedRateLimiter } from './sharedRateLimiter';
import { resolveConnectorConfirmationPolicy } from './toolPolicy';
import { UserConnectorOAuthService } from './userOAuthService';

export interface PlatformConnectorRuntimeManifest extends ToolManifest {
  platformConnectorAgentPolicy: {
    revision: number;
    selections: ConnectorDependencySelection[];
  };
  platformConnectorProof?: ConnectorOwnedOperationProof;
  platformConnectorTombstone?: boolean;
  /** Stable machine code for presentation-layer i18n (never a raw locale string). */
  platformConnectorTombstoneMessageCode?: string;
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

export const matchesConnectorApprovalReceipt = (params: {
  apiName: string;
  arguments: unknown;
  identifier: string;
  proof: ConnectorOwnedOperationProof;
  receipt: ConnectorApprovalReceipt;
  toolCallId: string;
  toolType: string;
}): boolean =>
  params.receipt.toolCallId === params.toolCallId &&
  params.receipt.toolCallFingerprint ===
    fingerprintConnectorToolCall({
      apiName: params.apiName,
      arguments: params.arguments,
      identifier: params.identifier,
      type: params.toolType,
    }) &&
  params.receipt.proof.userId === params.proof.userId &&
  params.receipt.proof.agentId === params.proof.agentId &&
  params.receipt.proof.connectorId === params.proof.connectorId &&
  params.receipt.proof.connectorKey === params.proof.connectorKey &&
  params.receipt.proof.publishedRevision === params.proof.publishedRevision &&
  params.receipt.proof.publishedChecksum === params.proof.publishedChecksum &&
  params.receipt.proof.toolPolicyFingerprint === params.proof.toolPolicyFingerprint &&
  params.receipt.proof.agentPolicyFingerprint === params.proof.agentPolicyFingerprint;

export const matchesConnectorDependencySelection = (params: {
  apiName: string;
  proof: ConnectorOwnedOperationProof;
  selection: ConnectorDependencySelection | undefined;
}): boolean =>
  params.selection?.connectorId === params.proof.connectorId &&
  params.selection.connectorKey === params.proof.connectorKey &&
  params.selection.publishedRevision === params.proof.publishedRevision &&
  params.selection.publishedChecksum === params.proof.publishedChecksum &&
  params.selection.allowedToolKeys.includes(params.apiName);

export const createConnectorApprovalReceipt = (params: {
  agentId: string;
  apiName: string;
  arguments: unknown;
  env?: ConnectorOAuthRuntimeEnv;
  identifier: string;
  manifest: unknown;
  operationId: string;
  toolCallId: string;
  type: string;
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
  const agentPolicy = manifest.platformConnectorAgentPolicy;
  const selection = agentPolicy?.selections.find(
    (candidate) => candidate.connectorKey === params.identifier,
  );
  if (
    !agentPolicy ||
    agentPolicy.revision !== proof.managedPolicyRevision ||
    !matchesConnectorDependencySelection({ apiName: params.apiName, proof, selection }) ||
    fingerprintConnectorAgentPolicy({
      agentId: params.agentId,
      managedPolicyRevision: agentPolicy.revision,
      selections: agentPolicy.selections,
    }) !== proof.agentPolicyFingerprint
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
  }
  return signer.signApprovalReceipt(
    proof,
    agentPolicy,
    params.toolCallId,
    fingerprintConnectorToolCall({
      apiName: params.apiName,
      arguments: params.arguments,
      identifier: params.identifier,
      type: params.type,
    }),
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
  serverAllowedConnectorKeys: string[];
  userId: string;
  workspaceId?: string;
}): Promise<{
  manifests: PlatformConnectorRuntimeManifest[];
  mode: ConnectorRuntimeEffectiveMode;
}> => {
  const effectiveState = await getConnectorRuntimeEffectiveState(params.env ?? process.env);
  const mode = effectiveState.mode;
  if (mode !== 'enforced') return { manifests: [], mode };

  const serverAllowed = new Set(params.serverAllowedConnectorKeys);
  const connectorKeys = [...new Set(params.connectorKeys)]
    .filter((connectorKey) => serverAllowed.has(connectorKey))
    .sort();
  const signer = new ConnectorOperationProofSigner(params.env ?? process.env);
  const approvedReceipt = params.approvedReceipt
    ? signer.verifyApprovalReceipt(params.approvedReceipt)
    : undefined;
  if (
    approvedReceipt &&
    (approvedReceipt.proof.userId !== params.userId ||
      approvedReceipt.proof.agentId !== params.agentId ||
      !approvedReceipt.agentPolicy.selections.some(
        (selection) => selection.connectorKey === approvedReceipt.proof.connectorKey,
      ) ||
      fingerprintConnectorAgentPolicy({
        agentId: params.agentId,
        managedPolicyRevision: approvedReceipt.agentPolicy.revision,
        selections: approvedReceipt.agentPolicy.selections,
      }) !== approvedReceipt.proof.agentPolicyFingerprint)
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
  }
  const legacyConnectors = await new ConnectorModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryByIdentifiers(connectorKeys);
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
      const current = await getConnectorPublishedIndex(params.db).resolveCurrent({
        connectorKey,
        operationId: params.operationId,
      });
      if (current.kind !== 'published') {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
      }
      const exact = await getSnapshots(params.db).resolveExact(
        toConnectorOperationProof(approvedReceipt.proof),
      );
      const selection = approvedReceipt.agentPolicy.selections.find(
        (candidate) => candidate.connectorKey === connectorKey,
      );
      if (
        !selection ||
        selection.connectorId !== exact.proof.connectorId ||
        selection.publishedRevision !== exact.proof.publishedRevision ||
        selection.publishedChecksum !== exact.proof.publishedChecksum
      ) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
      }
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
          proof: signer.signProof({
            agentId: params.agentId,
            agentPolicyFingerprint: approvedReceipt.proof.agentPolicyFingerprint,
            managedPolicyRevision: approvedReceipt.proof.managedPolicyRevision,
            proof: { ...exact.proof, operationId: params.operationId },
            userId: params.userId,
          }),
          selection,
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
        // Do not put i18n keys in user-visible description — presentation
        // localizes via platformConnectorTombstone + messageCode only.
        meta: {
          description: '',
          title: connectorKey,
        },
        platformConnectorAgentPolicy: { revision: effectiveState.revision, selections: [] },
        platformConnectorTombstone: true,
        platformConnectorTombstoneMessageCode: 'connectorCatalog.tombstone.unavailable',
        type: 'mcp',
      });
      continue;
    }
    const snapshot = indexed.snapshot;
    const selection: ConnectorDependencySelection = {
      allowedToolKeys: snapshot.payload.tools
        .filter((tool) => tool.platformPolicy === 'allow')
        .map((tool) => tool.toolKey)
        .sort(),
      connectorId: snapshot.proof.connectorId,
      connectorKey,
      publishedChecksum: snapshot.proof.publishedChecksum,
      publishedRevision: snapshot.proof.publishedRevision,
    };
    const agentPolicy = { revision: effectiveState.revision, selections: [selection] };
    const agentPolicyFingerprint = fingerprintConnectorAgentPolicy({
      agentId: params.agentId,
      managedPolicyRevision: effectiveState.revision,
      selections: agentPolicy.selections,
    });
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
        selection,
        snapshot,
      }),
    );
  }
  return { manifests, mode };
};

/**
 * Self-referential managed-policy revision bound into a platform Agent's pinned Connector manifests
 * (M10 PR-049 · CONNECTOR-EXACT). `managedPolicyRevision` is only ever compared against the manifest's
 * own `agentPolicy.revision` + the recomputed fingerprint at execution — never the live managed
 * policy — so a fixed marker keeps the agentPolicyFingerprint (and therefore any human-approval
 * receipt) stable across resume/retry, independent of live policy churn.
 */
const PINNED_CONNECTOR_MANAGED_POLICY_REVISION = 0;

/**
 * Build managed Connector manifests for a platform Agent from its immutable, per-operation pinned
 * Connector refs (M10 PR-049 · CONNECTOR-EXACT) — the EXACT historical published revisions, not the
 * current catalog head. Each ref is exact-resolved via `freezeExact` (fail-closed on missing /
 * non-published / checksum-mismatched revision), the pinned allowlist is validated against the exact
 * revision's allow-policy tools (a tool not allow-listed in that revision is a fail-closed
 * escalation), and the resulting manifest exposes ONLY the pinned tools. Publishing v2 / advancing
 * the head cannot change an in-flight operation's manifests or allowlist; resume/retry rebuild the
 * same v1 manifests deterministically (so an approval receipt still matches). Fail-closed when the
 * Agent pinned Connectors but managed Connectors are not enforced. No M09 read when there are none.
 */
export const buildPinnedManagedConnectorManifests = async (params: {
  agentId: string;
  db: LobeChatDatabase;
  env?: ConnectorOAuthRuntimeEnv;
  operationId: string;
  pinnedConnectors: PlatformAgentConnectorDependencyRef[];
  userId: string;
  workspaceId?: string;
}): Promise<{
  manifests: PlatformConnectorRuntimeManifest[];
  mode: ConnectorRuntimeEffectiveMode;
}> => {
  if (params.pinnedConnectors.length === 0) return { manifests: [], mode: 'enforced' };

  const effectiveState = await getConnectorRuntimeEffectiveState(params.env ?? process.env);
  if (effectiveState.mode !== 'enforced') {
    // The Agent pinned Connectors but managed Connectors are not enforced — cannot honor them.
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }

  const signer = new ConnectorOperationProofSigner(params.env ?? process.env);
  const snapshots = getSnapshots(params.db);

  // Legacy per-tool permission overlay (user disabled / needs-approval), same as the current path.
  const connectorKeys = [...new Set(params.pinnedConnectors.map((ref) => ref.connectorKey))];
  const legacyConnectors = await new ConnectorModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryByIdentifiers(connectorKeys);
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
  const orderedRefs = [...params.pinnedConnectors].sort((left, right) =>
    left.connectorKey.localeCompare(right.connectorKey),
  );
  for (const ref of orderedRefs) {
    const snapshot = await snapshots.freezeExact({
      connectorId: ref.connectorId,
      connectorKey: ref.connectorKey,
      operationId: params.operationId,
      publishedChecksum: ref.publishedChecksum,
      publishedRevision: ref.publishedRevision,
    });
    // No tool escalation: every pinned allowed tool must be an allow-policy tool in THIS exact
    // revision. A ref tool that is not allow-listed in the pinned snapshot fails closed.
    const allowableTools = new Set(
      snapshot.payload.tools
        .filter((tool) => tool.platformPolicy === 'allow')
        .map((tool) => tool.toolKey),
    );
    const allowedToolKeys = [...new Set(ref.allowedToolKeys)].sort();
    if (allowedToolKeys.some((toolKey) => !allowableTools.has(toolKey))) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
    const selection: ConnectorDependencySelection = {
      allowedToolKeys,
      connectorId: snapshot.proof.connectorId,
      connectorKey: ref.connectorKey,
      publishedChecksum: snapshot.proof.publishedChecksum,
      publishedRevision: snapshot.proof.publishedRevision,
    };
    const agentPolicy = {
      revision: PINNED_CONNECTOR_MANAGED_POLICY_REVISION,
      selections: [selection],
    };
    const agentPolicyFingerprint = fingerprintConnectorAgentPolicy({
      agentId: params.agentId,
      managedPolicyRevision: PINNED_CONNECTOR_MANAGED_POLICY_REVISION,
      selections: agentPolicy.selections,
    });
    const legacyConnector = legacyByKey.get(ref.connectorKey);
    const permissionByTool = new Map(
      (legacyConnector ? (legacyToolsByConnector.get(legacyConnector.id) ?? []) : []).map(
        (tool) => [tool.toolName, tool.permission],
      ),
    );
    manifests.push(
      buildPublishedManifest({
        agentPolicy,
        connectorKey: ref.connectorKey,
        permissionByTool,
        proof: signer.signProof({
          agentId: params.agentId,
          agentPolicyFingerprint,
          managedPolicyRevision: PINNED_CONNECTOR_MANAGED_POLICY_REVISION,
          proof: snapshot.proof,
          userId: params.userId,
        }),
        selection,
        snapshot,
      }),
    );
  }
  return { manifests, mode: 'enforced' };
};

const buildPublishedManifest = (params: {
  agentPolicy: PlatformConnectorRuntimeManifest['platformConnectorAgentPolicy'];
  connectorKey: string;
  permissionByTool: Map<string, string>;
  proof: ConnectorOwnedOperationProof;
  selection: ConnectorDependencySelection;
  snapshot: Awaited<ReturnType<ConnectorOperationSnapshotService['resolveExact']>>;
}): PlatformConnectorRuntimeManifest => ({
  api: params.snapshot.payload.tools
    .filter((tool) => tool.platformPolicy === 'allow')
    .filter((tool) => params.selection.allowedToolKeys.includes(tool.toolKey))
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
    const adapter = new PlatformConnectorRuntimeAdapter({
      assertCurrentPublished: async () => {
        const current = await getConnectorPublishedIndex(params.db!).resolveCurrent({
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
            ? appendConnectorRuntimeAudit(params.db!, {
                ...entry,
                idempotencyKey: entry.idempotencyKey,
                outcome: entry.outcome === 'allowed' ? 'allowed' : 'unknown',
              })
            : new PlatformAuditService(params.db!)
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
        new PlatformUserConnectorBindingRepository(params.db!, userId).getBinding(connectorId),
      journal: new DatabaseConnectorRuntimeExecutionJournal(params.db),
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
