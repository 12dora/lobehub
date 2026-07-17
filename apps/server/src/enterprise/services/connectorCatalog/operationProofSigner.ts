import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { z } from 'zod';

import {
  connectorApprovalReceiptSchema,
  connectorOperationProofSchema,
  connectorOwnedOperationProofSchema,
} from '../../contracts/platformConnectors';
import { parsePlatformSecretConfig } from '../../security/secret';
import { PlatformConnectorContractError } from './errors';
import type { ConnectorOAuthRuntimeEnv } from './oauthRuntime';
import type { ConnectorOperationProof } from './operationSnapshot';

export type ConnectorOwnedOperationProof = z.infer<typeof connectorOwnedOperationProofSchema>;
export type ConnectorApprovalReceipt = z.infer<typeof connectorApprovalReceiptSchema>;

const canonical = (values: Array<number | string>): string => JSON.stringify(values);

const mac = (key: Buffer, values: Array<number | string>): string =>
  createHmac('sha256', key).update(canonical(values)).digest('hex');

const proofValues = (
  proof: Omit<ConnectorOwnedOperationProof, 'signature'>,
): Array<number | string> => [
  proof.agentId,
  proof.agentPolicyFingerprint,
  proof.connectorId,
  proof.connectorKey,
  proof.managedPolicyRevision,
  proof.operationId,
  proof.publishedChecksum,
  proof.publishedRevision,
  proof.toolPolicyFingerprint,
  proof.userId,
];

const receiptValues = (receipt: Omit<ConnectorApprovalReceipt, 'signature'>) => [
  receipt.agentPolicy.revision,
  ...receipt.agentPolicy.connectorKeys,
  receipt.proof.signature,
  receipt.proof.operationId,
  receipt.proof.userId,
  receipt.proof.agentId,
  receipt.proof.connectorId,
  receipt.proof.connectorKey,
  receipt.toolCallFingerprint,
  receipt.toolCallId,
];

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
};

const normalizeToolArguments = (value: unknown): unknown => {
  if (typeof value !== 'string') return canonicalize(value);
  try {
    return canonicalize(JSON.parse(value));
  } catch {
    return value;
  }
};

export const fingerprintConnectorToolCall = (params: {
  apiName: string;
  arguments: unknown;
  identifier: string;
  type: string;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        params.type,
        params.identifier,
        params.apiName,
        normalizeToolArguments(params.arguments),
      ]),
    )
    .digest('hex');

const equalMac = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

export const fingerprintConnectorAgentPolicy = (params: {
  agentId: string;
  connectorKeys: string[];
  managedPolicyRevision: number;
}): string =>
  createHash('sha256')
    .update(
      canonical([
        params.agentId,
        params.managedPolicyRevision,
        ...[...new Set(params.connectorKeys.map((key) => key.trim()).filter(Boolean))].sort(),
      ]),
    )
    .digest('hex');

export class ConnectorOperationProofSigner {
  private readonly key: Buffer;

  constructor(env: ConnectorOAuthRuntimeEnv = process.env) {
    const encoded = parsePlatformSecretConfig(env).masterKeyBase64;
    const key = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
    if (key.length !== 32) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
    this.key = key;
  }

  signProof = (params: {
    agentId: string;
    agentPolicyFingerprint: string;
    managedPolicyRevision: number;
    proof: ConnectorOperationProof;
    userId: string;
  }): ConnectorOwnedOperationProof => {
    const unsigned = connectorOwnedOperationProofSchema.omit({ signature: true }).parse({
      ...params.proof,
      agentId: params.agentId,
      agentPolicyFingerprint: params.agentPolicyFingerprint,
      managedPolicyRevision: params.managedPolicyRevision,
      userId: params.userId,
    });
    return connectorOwnedOperationProofSchema.parse({
      ...unsigned,
      signature: mac(this.key, proofValues(unsigned)),
    });
  };

  verifyProof = (value: unknown): ConnectorOwnedOperationProof => {
    const proof = connectorOwnedOperationProofSchema.parse(value);
    const { signature: _signature, ...unsigned } = proof;
    if (!equalMac(proof.signature, mac(this.key, proofValues(unsigned)))) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
    return proof;
  };

  signApprovalReceipt = (
    proof: ConnectorOwnedOperationProof,
    agentPolicy: ConnectorApprovalReceipt['agentPolicy'],
    toolCallId: string,
    toolCallFingerprint: string,
  ): ConnectorApprovalReceipt => {
    const verified = this.verifyProof(proof);
    const unsigned = { agentPolicy, proof: verified, toolCallFingerprint, toolCallId };
    return connectorApprovalReceiptSchema.parse({
      ...unsigned,
      signature: mac(this.key, receiptValues(unsigned)),
    });
  };

  verifyApprovalReceipt = (value: unknown): ConnectorApprovalReceipt => {
    const receipt = connectorApprovalReceiptSchema.parse(value);
    this.verifyProof(receipt.proof);
    const { signature: _signature, ...unsigned } = receipt;
    if (!equalMac(receipt.signature, mac(this.key, receiptValues(unsigned)))) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
    return receipt;
  };
}

export const toConnectorOperationProof = (
  proof: ConnectorOwnedOperationProof,
): ConnectorOperationProof =>
  connectorOperationProofSchema.parse({
    connectorId: proof.connectorId,
    connectorKey: proof.connectorKey,
    operationId: proof.operationId,
    publishedChecksum: proof.publishedChecksum,
    publishedRevision: proof.publishedRevision,
    toolPolicyFingerprint: proof.toolPolicyFingerprint,
  });
