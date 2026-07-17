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
const selection = {
  allowedToolKeys: ['search'],
  connectorId: baseProof.connectorId,
  connectorKey: baseProof.connectorKey,
  publishedChecksum: baseProof.publishedChecksum,
  publishedRevision: baseProof.publishedRevision,
};

describe('ConnectorOperationProofSigner', () => {
  it('fingerprints exact dependency revisions and tool allowlists', () => {
    const base = {
      agentId: 'agent-1',
      managedPolicyRevision: 9,
      selections: [selection],
    };
    const fingerprint = fingerprintConnectorAgentPolicy(base);

    expect(
      fingerprintConnectorAgentPolicy({
        ...base,
        selections: [{ ...selection, publishedRevision: selection.publishedRevision + 1 }],
      }),
    ).not.toBe(fingerprint);
    expect(
      fingerprintConnectorAgentPolicy({
        ...base,
        selections: [{ ...selection, allowedToolKeys: ['delete'] }],
      }),
    ).not.toBe(fingerprint);
  });

  it('rejects cross-user, cross-agent, cross-connector and policy tampering', () => {
    const signer = new ConnectorOperationProofSigner(env);
    const proof = signer.signProof({
      agentId: 'agent-1',
      agentPolicyFingerprint: fingerprintConnectorAgentPolicy({
        agentId: 'agent-1',
        managedPolicyRevision: 9,
        selections: [selection],
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
    const agentPolicy = { revision: 9, selections: [selection] };
    const proof = signer.signProof({
      agentId: 'agent-1',
      agentPolicyFingerprint: fingerprintConnectorAgentPolicy({
        agentId: 'agent-1',
        managedPolicyRevision: agentPolicy.revision,
        selections: agentPolicy.selections,
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
