import type { PlatformAgentConnectorDependencyRef, ToolManifest } from '@lobechat/types';

import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import { ConnectorToolPermission } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformConnectorContractError } from './errors';
import { loadLegacyToolPermissionOverlay } from './legacyToolPermissionOverlay';
import type { ConnectorOAuthRuntimeEnv } from './oauthRuntime';
import {
  type ConnectorApprovalReceipt,
  type ConnectorDependencySelection,
  ConnectorOperationProofSigner,
  type ConnectorOwnedOperationProof,
  fingerprintConnectorAgentPolicy,
  toConnectorOperationProof,
} from './operationProofSigner';
import { ConnectorOperationSnapshotService } from './operationSnapshot';
import { getConnectorPublishedIndex } from './publishedIndex';
import type { ConnectorRuntimeEffectiveMode } from './runtimeEffectiveState';
import { getConnectorRuntimeEffectiveState } from './runtimeEffectiveState';
import { resolveConnectorConfirmationPolicy } from './toolPolicy';

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

const snapshotsByDatabase = new WeakMap<object, ConnectorOperationSnapshotService>();

export const getSnapshots = (db: LobeChatDatabase): ConnectorOperationSnapshotService => {
  const key = db as object;
  const existing = snapshotsByDatabase.get(key);
  if (existing) return existing;
  const created = new ConnectorOperationSnapshotService(new PlatformConnectorCatalogRepository(db));
  snapshotsByDatabase.set(key, created);
  return created;
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
  const legacyOverlay = await loadLegacyToolPermissionOverlay({
    connectorKeys,
    db: params.db,
    userId: params.userId,
    workspaceId: params.workspaceId,
  });

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
      const permissionByTool = legacyOverlay.permissionsFor(connectorKey);
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
    const permissionByTool = legacyOverlay.permissionsFor(connectorKey);
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
  const legacyOverlay = await loadLegacyToolPermissionOverlay({
    connectorKeys,
    db: params.db,
    userId: params.userId,
    workspaceId: params.workspaceId,
  });

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
    const permissionByTool = legacyOverlay.permissionsFor(ref.connectorKey);
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
