import type { ToolManifest } from '@lobechat/types';

import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { resolveConnectorGovernance } from '../connectorGovernance/resolve';
import { CONNECTOR_GOVERNANCE_DENY_SHARED_OWNER } from '../connectorGovernance/types';
import type { ConnectorOAuthRuntimeEnv } from './oauthRuntime';
import type { ConnectorOwnedOperationProof } from './operationProofSigner';
import {
  ConnectorOperationProofSigner,
  fingerprintConnectorAgentPolicy,
} from './operationProofSigner';
import type { PlatformConnectorRuntimeManifest } from './runtimeManifests';
import { resolveConnectorRuntimeMode } from './runtimeMode';
import {
  matchesConnectorApprovalReceipt,
  matchesConnectorDependencySelection,
} from './runtimeProofMatchers';

export type ManagedAdmission =
  | { kind: 'bypass' }
  | { kind: 'deny'; code: string }
  | {
      agentId: string;
      apiName: string;
      arguments: string | Record<string, unknown>;
      effectiveBindingUserId?: string;
      humanApproved: boolean;
      kind: 'admit';
      operationId: string;
      proof: ConnectorOwnedOperationProof;
      toolCallId: string;
      userId: string;
    };

export interface AdmitManagedConnectorExecutionParams {
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
}

export const admitManagedConnectorExecution = async (
  params: AdmitManagedConnectorExecutionParams,
): Promise<ManagedAdmission> => {
  const flags = parseEnterpriseFeatureFlags(params.env ?? process.env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS || !params.db) return { kind: 'bypass' };

  const mode = await resolveConnectorRuntimeMode({ env: params.env });
  if (mode === 'legacy') return { kind: 'bypass' };
  if (mode === 'blocked') return { kind: 'deny', code: 'PLATFORM_CONNECTOR_NOT_PUBLISHED' };

  if (
    !params.userId ||
    !params.agentId ||
    !params.operationId ||
    !params.toolCallId ||
    !params.toolType
  ) {
    return { kind: 'deny', code: 'PLATFORM_CONNECTOR_TOOL_DENIED' };
  }
  const manifest = params.manifest as Partial<PlatformConnectorRuntimeManifest> | undefined;
  if (manifest?.platformConnectorTombstone) {
    return { kind: 'deny', code: 'PLATFORM_CONNECTOR_NOT_PUBLISHED' };
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
  if (!agentPolicyAllowed) return { kind: 'deny', code: 'PLATFORM_CONNECTOR_TOOL_DENIED' };

  if (proof.operationId !== params.operationId) {
    return { kind: 'deny', code: 'PLATFORM_CONNECTOR_TOOL_DENIED' };
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
    return { kind: 'deny', code: 'PLATFORM_CONNECTOR_TOOL_DENIED' };
  }
  const effectiveBindingUserId =
    governance.active && governance.sharedAuthOwnerUserId
      ? governance.sharedAuthOwnerUserId
      : undefined;

  return {
    agentId: params.agentId,
    apiName: params.apiName,
    arguments: params.arguments,
    effectiveBindingUserId,
    humanApproved,
    kind: 'admit',
    operationId: params.operationId,
    proof,
    toolCallId: params.toolCallId,
    userId: params.userId,
  };
};
