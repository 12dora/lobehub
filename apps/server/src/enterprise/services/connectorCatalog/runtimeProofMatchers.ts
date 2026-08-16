import { PlatformConnectorContractError } from './errors';
import type { ConnectorOAuthRuntimeEnv } from './oauthRuntime';
import {
  type ConnectorApprovalReceipt,
  type ConnectorDependencySelection,
  ConnectorOperationProofSigner,
  type ConnectorOwnedOperationProof,
  fingerprintConnectorAgentPolicy,
  fingerprintConnectorToolCall,
} from './operationProofSigner';
import type { PlatformConnectorRuntimeManifest } from './runtimeManifests';

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
