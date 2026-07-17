import { describe, expect, it, vi } from 'vitest';

import { checksumPayload } from '@/database/models/platform';
import type {
  PlatformConnectorCatalogRepository,
  PlatformConnectorRevisionPayload,
} from '@/database/repositories/platformConnectorCatalog';
import type { PlatformConnectorItem } from '@/database/schemas/platform/connectors';

import { ConnectorOperationSnapshotService } from './operationSnapshot';

const tool = {
  description: null,
  displayName: 'Search',
  inputSchema: { type: 'object' },
  outputSchema: {},
  platformPolicy: 'allow' as const,
  requiresConfirmation: false,
  riskLevel: 'low' as const,
  sort: 0,
  toolKey: 'search',
};

const payload = (revision: number): PlatformConnectorRevisionPayload => ({
  connector: {
    credentialMode: 'none',
    description: null,
    displayName: `Catalog ${revision}`,
    enabled: true,
    endpoint: `https://connector.example.test/v${revision}`,
    id: 'connector-1',
    key: 'catalog',
    oauthClientSecretConfigured: false,
    oauthClientSecretFingerprint: null,
    oauthConfig: null,
    sharedSecretConfigured: false,
    sharedSecretFingerprint: null,
    sort: 0,
    transport: 'http',
  },
  schemaVersion: 'm09-v1',
  tools: [tool],
});

const runtime = (revision: number, runtimePayload = payload(revision)) => ({
  payload: runtimePayload,
  provenance: {
    checksum: checksumPayload(runtimePayload),
    connectorId: 'connector-1',
    publishedAt: new Date('2026-07-17T00:00:00Z'),
    revision,
    revisionId: `revision-${revision}`,
  },
});

const connector = (revision = 1): PlatformConnectorItem => ({
  connectorKey: 'catalog',
  createdAt: new Date(),
  createdBy: null,
  credentialMode: 'none',
  description: null,
  displayName: 'Catalog',
  enabled: true,
  endpoint: 'https://connector.example.test/v1',
  id: 'connector-1',
  legacyConnectionType: 'http',
  legacyEncryptedSharedCredentials: null,
  legacyIsRequired: false,
  legacyMcpServerUrl: 'https://connector.example.test/v1',
  legacyMcpStdioConfig: null,
  legacyName: 'Catalog',
  legacyOidcConfig: null,
  legacySecretFingerprint: null,
  legacySourceType: 'custom',
  oauthClientSecretFingerprint: null,
  oauthClientSecretRef: null,
  oauthClientSecretUpdatedAt: null,
  oauthConfig: null,
  publishedAt: new Date(),
  publishedChecksum: runtime(revision).provenance.checksum,
  publishedResourceType: 'connector',
  publishedRevision: revision,
  revision,
  sharedSecretFingerprint: null,
  sharedSecretRef: null,
  sharedSecretUpdatedAt: null,
  sort: 0,
  status: 'published',
  transport: 'http',
  updatedAt: new Date(),
  updatedBy: null,
});

const createRepository = () => {
  const revisions = new Map([
    [1, runtime(1)],
    [2, runtime(2)],
    [3, runtime(3)],
  ]);
  const getConnectorByKey = vi.fn<PlatformConnectorCatalogRepository['getConnectorByKey']>();
  const getCurrentPublishedRuntime =
    vi.fn<PlatformConnectorCatalogRepository['getCurrentPublishedRuntime']>();
  const getPublishedRuntimeRevision =
    vi.fn<PlatformConnectorCatalogRepository['getPublishedRuntimeRevision']>();
  getConnectorByKey.mockResolvedValue(connector());
  getCurrentPublishedRuntime.mockResolvedValue(revisions.get(1));
  getPublishedRuntimeRevision.mockImplementation(async (_connectorId, revision) =>
    revisions.get(revision),
  );
  return {
    getConnectorByKey,
    getCurrentPublishedRuntime,
    getPublishedRuntimeRevision,
    revisions,
  };
};

describe('ConnectorOperationSnapshotService', () => {
  it('keeps an operation on its exact revision across publish and rollback pointer drift', async () => {
    const repository = createRepository();
    const service = new ConnectorOperationSnapshotService(repository);
    const frozen = await service.freezeCurrent({ connectorKey: 'catalog', operationId: 'op-1' });

    repository.getConnectorByKey.mockResolvedValue(connector(2));
    repository.getCurrentPublishedRuntime.mockResolvedValue(runtime(2));
    const exact = await service.resolveExact(frozen.proof);
    expect(exact.payload.connector.endpoint).toBe('https://connector.example.test/v1');
    expect(exact.proof.publishedRevision).toBe(1);
    expect(repository.getPublishedRuntimeRevision).not.toHaveBeenCalled();
  });

  it('blocks new operations after disable/archive while a historical exact proof can finish', async () => {
    const repository = createRepository();
    const service = new ConnectorOperationSnapshotService(repository);
    const frozen = await service.freezeCurrent({ connectorKey: 'catalog', operationId: 'op-1' });
    repository.getConnectorByKey.mockResolvedValue({
      ...connector(),
      enabled: false,
      status: 'archived',
    });

    await expect(
      service.freezeCurrent({ connectorKey: 'catalog', operationId: 'op-2' }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    await expect(service.resolveExact(frozen.proof)).resolves.toMatchObject({
      proof: { operationId: 'op-1', publishedRevision: 1 },
    });
  });

  it('rejects canonical payload tampering, policy drift, and mutable cache poisoning', async () => {
    const repository = createRepository();
    const service = new ConnectorOperationSnapshotService(repository);
    const frozen = await service.freezeCurrent({ connectorKey: 'catalog', operationId: 'op-1' });
    expect(Object.isFrozen(frozen.payload.tools[0])).toBe(true);
    expect(() => {
      frozen.payload.tools[0]!.platformPolicy = 'deny';
    }).toThrow();

    const tampered = structuredClone(runtime(1));
    tampered.payload.connector.endpoint = 'https://attacker.example.test';
    repository.getPublishedRuntimeRevision.mockResolvedValue(tampered);
    const cold = new ConnectorOperationSnapshotService(repository);
    await expect(cold.resolveExact(frozen.proof)).rejects.toThrow(
      'PLATFORM_CONNECTOR_NOT_PUBLISHED',
    );

    await expect(
      cold.resolveExact({ ...frozen.proof, toolPolicyFingerprint: '0'.repeat(64) }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  });

  it('keeps the immutable revision cache bounded and reloads evicted proofs', async () => {
    const repository = createRepository();
    const service = new ConnectorOperationSnapshotService(repository, { maxCacheEntries: 2 });
    const proofs = [];
    for (const revision of [1, 2, 3]) {
      repository.getConnectorByKey.mockResolvedValue(connector(revision));
      repository.getCurrentPublishedRuntime.mockResolvedValue(runtime(revision));
      proofs.push(
        (await service.freezeCurrent({ connectorKey: 'catalog', operationId: `op-${revision}` }))
          .proof,
      );
    }
    await service.resolveExact(proofs[0]!);
    expect(repository.getPublishedRuntimeRevision).toHaveBeenCalledWith('connector-1', 1);
  });
});
