import type { z } from 'zod';

import { checksumPayload } from '@/database/models/platform';
import type {
  PlatformConnectorCatalogRepository,
  PlatformConnectorRevisionPayload,
} from '@/database/repositories/platformConnectorCatalog';

import { connectorOperationProofSchema } from '../../contracts/platformConnectors';
import { parseConnectorRevisionPayload } from './catalogSnapshot';
import { PlatformConnectorContractError } from './errors';
import { fingerprintConnectorToolPolicy } from './toolPolicy';

export type ConnectorOperationProof = z.infer<typeof connectorOperationProofSchema>;

export interface FrozenConnectorOperationSnapshot {
  payload: PlatformConnectorRevisionPayload;
  proof: ConnectorOperationProof;
  publishedAt: Date;
}

interface OperationSnapshotRepository {
  getConnectorByKey: PlatformConnectorCatalogRepository['getConnectorByKey'];
  getCurrentPublishedRuntime: PlatformConnectorCatalogRepository['getCurrentPublishedRuntime'];
  getPublishedRuntimeRevision: PlatformConnectorCatalogRepository['getPublishedRuntimeRevision'];
}

const DEFAULT_MAX_OPERATION_SNAPSHOTS = 256;

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const proofCacheKey = (proof: ConnectorOperationProof): string =>
  [
    proof.operationId,
    proof.connectorId,
    proof.connectorKey,
    proof.publishedRevision,
    proof.publishedChecksum,
    proof.toolPolicyFingerprint,
  ].join(':');

/**
 * Freezes a Published Connector at the operation boundary. The proof is safe to
 * persist with the operation tool set: it contains identities and hashes only.
 */
export class ConnectorOperationSnapshotService {
  private readonly cache = new Map<string, FrozenConnectorOperationSnapshot>();
  private readonly maxCacheEntries: number;

  constructor(
    private readonly repository: OperationSnapshotRepository,
    options: { maxCacheEntries?: number } = {},
  ) {
    this.maxCacheEntries = Math.max(
      1,
      Math.min(options.maxCacheEntries ?? DEFAULT_MAX_OPERATION_SNAPSHOTS, 1024),
    );
  }

  freezeCurrent = async (params: {
    connectorKey: string;
    operationId: string;
  }): Promise<FrozenConnectorOperationSnapshot> => {
    const connector = await this.repository.getConnectorByKey(params.connectorKey);
    if (
      !connector ||
      connector.status !== 'published' ||
      !connector.enabled ||
      !connector.publishedRevision ||
      !connector.publishedChecksum
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const runtime = await this.repository.getCurrentPublishedRuntime(connector.id);
    if (
      !runtime ||
      runtime.provenance.revision !== connector.publishedRevision ||
      runtime.provenance.checksum !== connector.publishedChecksum
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    return this.validateAndRemember({
      expectedConnectorKey: params.connectorKey,
      operationId: params.operationId,
      runtime,
    });
  };

  /**
   * Freeze an EXACT historical published Connector revision by its pinned coordinates
   * (M10 PR-049 · CONNECTOR-EXACT). Unlike {@link resolveExact}, the caller has no prior proof
   * (and therefore no `toolPolicyFingerprint`): the fingerprint is computed from the exact
   * revision's own tool policy. Fail-closed on a missing / non-published / checksum-mismatched
   * revision, or a payload whose connector id/key/enabled does not match the pin.
   */
  freezeExact = async (params: {
    connectorId: string;
    connectorKey: string;
    operationId: string;
    publishedChecksum: string;
    publishedRevision: number;
  }): Promise<FrozenConnectorOperationSnapshot> => {
    const runtime = await this.repository.getPublishedRuntimeRevision(
      params.connectorId,
      params.publishedRevision,
    );
    if (!runtime || runtime.provenance.checksum !== params.publishedChecksum) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    return this.validateAndRemember({
      expectedConnectorKey: params.connectorKey,
      operationId: params.operationId,
      runtime,
    });
  };

  resolveExact = async (
    rawProof: ConnectorOperationProof,
  ): Promise<FrozenConnectorOperationSnapshot> => {
    const proof = connectorOperationProofSchema.parse(rawProof);
    const cached = this.cache.get(proofCacheKey(proof));
    if (cached) {
      this.cache.delete(proofCacheKey(proof));
      this.cache.set(proofCacheKey(proof), cached);
      return cached;
    }
    const runtime = await this.repository.getPublishedRuntimeRevision(
      proof.connectorId,
      proof.publishedRevision,
    );
    if (!runtime || runtime.provenance.checksum !== proof.publishedChecksum) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const resolved = this.validateAndRemember({
      expectedConnectorKey: proof.connectorKey,
      operationId: proof.operationId,
      runtime,
    });
    if (proofCacheKey(resolved.proof) !== proofCacheKey(proof)) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    return resolved;
  };

  private validateAndRemember = (params: {
    expectedConnectorKey: string;
    operationId: string;
    runtime: NonNullable<
      Awaited<ReturnType<PlatformConnectorCatalogRepository['getCurrentPublishedRuntime']>>
    >;
  }): FrozenConnectorOperationSnapshot => {
    if (checksumPayload(params.runtime.payload) !== params.runtime.provenance.checksum) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const payload = parseConnectorRevisionPayload(params.runtime.payload);
    if (
      payload.connector.id !== params.runtime.provenance.connectorId ||
      payload.connector.key !== params.expectedConnectorKey ||
      !payload.connector.enabled
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const proof = connectorOperationProofSchema.parse({
      connectorId: payload.connector.id,
      connectorKey: payload.connector.key,
      operationId: params.operationId,
      publishedChecksum: params.runtime.provenance.checksum,
      publishedRevision: params.runtime.provenance.revision,
      toolPolicyFingerprint: fingerprintConnectorToolPolicy(payload.tools),
    });
    const frozen = deepFreeze({
      payload: structuredClone(payload),
      proof,
      publishedAt: new Date(params.runtime.provenance.publishedAt),
    });
    const key = proofCacheKey(proof);
    this.cache.delete(key);
    this.cache.set(key, frozen);
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return frozen;
  };
}

export { DEFAULT_MAX_OPERATION_SNAPSHOTS };
