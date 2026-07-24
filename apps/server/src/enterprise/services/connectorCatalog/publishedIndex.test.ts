import { describe, expect, it, vi } from 'vitest';

import { checksumPayload } from '@/database/models/platform';
import type { PlatformConnectorRevisionPayload } from '@/database/repositories/platformConnectorCatalog';
import type { PlatformConnectorItem } from '@/database/schemas/platform/connectors';

import { ConnectorPublishedIndex } from './publishedIndex';

const payload: PlatformConnectorRevisionPayload = {
  connector: {
    credentialMode: 'none',
    description: null,
    displayName: 'Catalog',
    enabled: true,
    endpoint: 'https://connector.example.test/mcp',
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
  tools: [
    {
      description: null,
      displayName: 'Search',
      inputSchema: { type: 'object' },
      outputSchema: {},
      platformPolicy: 'allow',
      requiresConfirmation: false,
      riskLevel: 'low',
      sort: 0,
      toolKey: 'search',
    },
  ],
};
const checksum = checksumPayload(payload);
const connector = (overrides: Partial<PlatformConnectorItem> = {}): PlatformConnectorItem => ({
  connectionTestErrorCategory: null,
  connectionTestLatencyMs: null,
  connectionTestMessageCode: null,
  connectionTestStatus: null,
  connectionTestedAt: null,
  connectionTestedDraftToken: null,
  connectionTestedRevision: null,
  connectorKey: 'catalog',
  createdAt: new Date(),
  createdBy: null,
  credentialMode: 'none',
  description: null,
  displayName: 'Catalog',
  enabled: true,
  endpoint: 'https://connector.example.test/mcp',
  id: 'connector-1',
  legacyConnectionType: 'http',
  legacyEncryptedSharedCredentials: null,
  legacyIsRequired: false,
  legacyMcpServerUrl: 'https://connector.example.test/mcp',
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
  publishedChecksum: checksum,
  publishedResourceType: 'connector',
  publishedRevision: 1,
  revision: 1,
  sharedSecretFingerprint: null,
  sharedSecretRef: null,
  sharedSecretUpdatedAt: null,
  sort: 0,
  status: 'published',
  transport: 'http',
  updatedAt: new Date(),
  updatedBy: null,
  ...overrides,
  migrationRequired: overrides.migrationRequired ?? false,
});

describe('ConnectorPublishedIndex', () => {
  it('validates a pointer once and resolves subsequent operations with bounded O(1) probes', async () => {
    const repository = {
      getConnectorByKey: vi.fn(async () => connector()),
      getCurrentPublishedRuntime: vi.fn(async () => ({
        payload,
        provenance: {
          checksum,
          connectorId: 'connector-1',
          publishedAt: new Date(),
          revision: 1,
          revisionId: 'revision-1',
        },
      })),
    };
    const index = new ConnectorPublishedIndex(repository);

    await expect(
      index.resolveCurrent({ connectorKey: 'catalog', operationId: 'op-1' }),
    ).resolves.toMatchObject({
      kind: 'published',
      snapshot: { proof: { operationId: 'op-1' } },
    });
    await expect(
      index.resolveCurrent({ connectorKey: 'catalog', operationId: 'op-2' }),
    ).resolves.toMatchObject({
      kind: 'published',
      snapshot: { proof: { operationId: 'op-2' } },
    });
    expect(repository.getConnectorByKey).toHaveBeenCalledTimes(2);
    expect(repository.getCurrentPublishedRuntime).toHaveBeenCalledTimes(1);
  });

  it('keeps an archived key as a tombstone and invalidates exact cached payloads explicitly', async () => {
    const repository = {
      getConnectorByKey: vi
        .fn()
        .mockResolvedValueOnce(connector())
        .mockResolvedValueOnce(connector({ enabled: false, status: 'archived' }))
        .mockResolvedValue(connector()),
      getCurrentPublishedRuntime: vi.fn(async () => ({
        payload,
        provenance: {
          checksum,
          connectorId: 'connector-1',
          publishedAt: new Date(),
          revision: 1,
          revisionId: 'revision-1',
        },
      })),
    };
    const index = new ConnectorPublishedIndex(repository);
    await index.resolveCurrent({ connectorKey: 'catalog', operationId: 'op-1' });
    await expect(
      index.resolveCurrent({ connectorKey: 'catalog', operationId: 'op-2' }),
    ).resolves.toMatchObject({
      connectorKey: 'catalog',
      kind: 'tombstone',
    });
    index.invalidate('connector-1');
    await index.resolveCurrent({ connectorKey: 'catalog', operationId: 'op-3' });
    expect(repository.getCurrentPublishedRuntime).toHaveBeenCalledTimes(2);
  });
});
