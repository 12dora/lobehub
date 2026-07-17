import { describe, expect, it } from 'vitest';

import {
  ConnectorOperationProofSigner,
  fingerprintConnectorAgentPolicy,
  fingerprintConnectorToolCall,
} from './operationProofSigner';

const env = { PLATFORM_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') };
const baseProof = {
  connectorId: 'connector-1',
  connectorKey: 'catalog',
  operationId: 'operation-1',
  publishedChecksum: 'a'.repeat(64),
  publishedRevision: 4,
  toolPolicyFingerprint: 'b'.repeat(64),
};

describe('ConnectorOperationProofSigner', () => {
  it('rejects cross-user, cross-agent, cross-connector and policy tampering', () => {
    const signer = new ConnectorOperationProofSigner(env);
    const connectorKeys = ['catalog'];
    const proof = signer.signProof({
      agentId: 'agent-1',
      agentPolicyFingerprint: fingerprintConnectorAgentPolicy({
        agentId: 'agent-1',
        connectorKeys,
        managedPolicyRevision: 9,
      }),
      managedPolicyRevision: 9,
      proof: baseProof,
      userId: 'user-1',
    });

    expect(signer.verifyProof(proof)).toEqual(proof);
    for (const tampered of [
      { ...proof, userId: 'user-2' },
      { ...proof, agentId: 'agent-2' },
      { ...proof, connectorKey: 'other' },
      { ...proof, agentPolicyFingerprint: 'c'.repeat(64) },
    ]) {
      expect(() => signer.verifyProof(tampered)).toThrow('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
  });

  it('binds an approval receipt to the exact proof and tool call', () => {
    const signer = new ConnectorOperationProofSigner(env);
    const agentPolicy = { connectorKeys: ['catalog'], revision: 9 };
    const proof = signer.signProof({
      agentId: 'agent-1',
      agentPolicyFingerprint: fingerprintConnectorAgentPolicy({
        agentId: 'agent-1',
        connectorKeys: agentPolicy.connectorKeys,
        managedPolicyRevision: agentPolicy.revision,
      }),
      managedPolicyRevision: agentPolicy.revision,
      proof: baseProof,
      userId: 'user-1',
    });
    const fingerprint = fingerprintConnectorToolCall({
      apiName: 'search',
      arguments: '{"b":2,"a":1}',
      identifier: 'catalog',
      type: 'mcp',
    });
    const receipt = signer.signApprovalReceipt(proof, agentPolicy, 'tool-call-1', fingerprint);

    expect(signer.verifyApprovalReceipt(receipt)).toEqual(receipt);
    expect(() => signer.verifyApprovalReceipt({ ...receipt, toolCallId: 'tool-call-2' })).toThrow(
      'PLATFORM_CONNECTOR_TOOL_DENIED',
    );
    expect(
      fingerprintConnectorToolCall({
        apiName: 'search',
        arguments: { a: 1, b: 2 },
        identifier: 'catalog',
        type: 'mcp',
      }),
    ).toBe(fingerprint);
    expect(
      fingerprintConnectorToolCall({
        apiName: 'delete',
        arguments: { a: 1, b: 2 },
        identifier: 'catalog',
        type: 'mcp',
      }),
    ).not.toBe(fingerprint);
  });
});
