// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  PlatformConnectorCatalogRepository,
  type PlatformConnectorRevisionPayload,
} from '@/database/repositories/platformConnectorCatalog';
import { platformConnectors, platformResourceRevisions } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { clearConnectorCatalogRuntimeCache, ConnectorCatalogReadService } from './catalogSnapshot';
import {
  cleanupM09ServiceData,
  ensurePendingM09ServiceSchema,
  MemoryConnectorSecretStore,
} from './catalogTestUtils';

const db: LobeChatDatabase = await getTestDB();
const connectorId = 'm09-snapshot-connector';

beforeAll(() => ensurePendingM09ServiceSchema(db));
beforeEach(async () => {
  clearConnectorCatalogRuntimeCache();
  await cleanupM09ServiceData(db);
});
afterEach(async () => {
  clearConnectorCatalogRuntimeCache();
  await cleanupM09ServiceData(db);
});

const payload = (endpoint: string): PlatformConnectorRevisionPayload => ({
  connector: {
    credentialMode: 'none',
    description: 'Safe public connector',
    displayName: 'Snapshot Connector',
    enabled: true,
    endpoint,
    id: connectorId,
    key: 'snapshot-connector',
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
      description: 'Search safely',
      displayName: 'Search',
      inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
      outputSchema: { type: 'object' },
      platformPolicy: 'allow',
      requiresConfirmation: false,
      riskLevel: 'low',
      sort: 0,
      toolKey: 'search.v1',
    },
  ],
});

const seedConnector = async () => {
  const repository = new PlatformConnectorCatalogRepository(db);
  await repository.createConnector({
    connectorKey: 'snapshot-connector',
    credentialMode: 'none',
    displayName: 'Mutable Draft',
    endpoint: 'https://mutable-draft.example.test/mcp',
    id: connectorId,
    status: 'draft',
  });
  return repository;
};

describe('ConnectorCatalogReadService exact snapshot boundary', () => {
  it('reads only the checksum-bound pointer revision and ignores mutable Draft drift', async () => {
    const repository = await seedConnector();
    const revisionOne = payload('https://revision-one.example.test/mcp');
    const checksumOne = checksumPayload(revisionOne);
    await repository.createPublishedRevision({
      checksum: checksumOne,
      connectorId,
      payload: revisionOne,
      publishedAt: new Date(),
      publishedBy: 'admin-user',
      revision: 1,
    });
    await repository.setPublishedPointerCas({
      checksum: checksumOne,
      connectorId,
      expectedRevision: 0,
      publishedAt: new Date(),
      publishedRevision: 1,
    });
    const revisionTwo = payload('https://unpointed-revision-two.example.test/mcp');
    await repository.createPublishedRevision({
      checksum: checksumPayload(revisionTwo),
      connectorId,
      payload: revisionTwo,
      publishedAt: new Date(),
      publishedBy: 'admin-user',
      revision: 2,
    });
    await db
      .update(platformConnectors)
      .set({ endpoint: 'https://mutated-draft.example.test/mcp' })
      .where(eq(platformConnectors.id, connectorId));

    const read = new ConnectorCatalogReadService(db, new MemoryConnectorSecretStore(db));
    await expect(read.getTrustedPublished(connectorId)).resolves.toMatchObject({
      endpoint: 'https://revision-one.example.test/mcp',
      publishedRevision: 1,
    });
    await expect(read.getTrustedPublished(connectorId)).resolves.toMatchObject({
      endpoint: 'https://revision-one.example.test/mcp',
      publishedRevision: 1,
    });
  });

  it('returns isolated admin, public, and trusted clones that cannot poison the cache', async () => {
    const repository = await seedConnector();
    const revision = payload('https://isolated.example.test/mcp');
    const checksum = checksumPayload(revision);
    await repository.createPublishedRevision({
      checksum,
      connectorId,
      payload: revision,
      publishedAt: new Date(),
      publishedBy: 'admin-user',
      revision: 1,
    });
    await repository.setPublishedPointerCas({
      checksum,
      connectorId,
      expectedRevision: 0,
      publishedAt: new Date(),
      publishedRevision: 1,
    });
    const read = new ConnectorCatalogReadService(db, new MemoryConnectorSecretStore(db));

    const admin = await read.getAdminPublished(connectorId);
    admin.displayName = 'mutated admin';
    admin.tools[0]!.inputSchema.type = 'number';
    const publicSnapshot = await read.getPublicPublished(connectorId);
    publicSnapshot.displayName = 'mutated public';
    publicSnapshot.tools[0]!.displayName = 'mutated tool';
    const trusted = await read.getTrustedPublished(connectorId);
    trusted.endpoint = 'https://mutated.example.test/mcp';
    trusted.tools[0]!.inputSchema.type = 'boolean';

    await expect(read.getAdminPublished(connectorId)).resolves.toMatchObject({
      displayName: 'Snapshot Connector',
      tools: [{ inputSchema: { type: 'object' } }],
    });
    await expect(read.getPublicPublished(connectorId)).resolves.toMatchObject({
      displayName: 'Snapshot Connector',
      tools: [{ displayName: 'Search' }],
    });
    await expect(read.getTrustedPublished(connectorId)).resolves.toMatchObject({
      endpoint: 'https://isolated.example.test/mcp',
      tools: [{ inputSchema: { type: 'object' } }],
    });
  });

  it('revalidates the database payload checksum even when the cache key already exists', async () => {
    const repository = await seedConnector();
    const revision = payload('https://cached.example.test/mcp');
    const checksum = checksumPayload(revision);
    const row = await repository.createPublishedRevision({
      checksum,
      connectorId,
      payload: revision,
      publishedAt: new Date(),
      publishedBy: 'admin-user',
      revision: 1,
    });
    await repository.setPublishedPointerCas({
      checksum,
      connectorId,
      expectedRevision: 0,
      publishedAt: new Date(),
      publishedRevision: 1,
    });
    const read = new ConnectorCatalogReadService(db, new MemoryConnectorSecretStore(db));
    await expect(read.getSnapshot(connectorId)).resolves.toMatchObject({
      provenance: { checksum },
    });
    await db
      .update(platformResourceRevisions)
      .set({ payload: payload('https://tampered-after-cache.example.test/mcp') })
      .where(eq(platformResourceRevisions.id, row.id));

    await expect(read.getSnapshot(connectorId)).rejects.toMatchObject({
      code: 'PLATFORM_CONNECTOR_NOT_PUBLISHED',
    });
  });

  it('fails closed when the stored payload does not match its bound checksum', async () => {
    const repository = await seedConnector();
    const revision = payload('https://tampered.example.test/mcp');
    const wrongChecksum = 'f'.repeat(64);
    await repository.createPublishedRevision({
      checksum: wrongChecksum,
      connectorId,
      payload: revision,
      publishedAt: new Date(),
      publishedBy: 'admin-user',
      revision: 1,
    });
    await repository.setPublishedPointerCas({
      checksum: wrongChecksum,
      connectorId,
      expectedRevision: 0,
      publishedAt: new Date(),
      publishedRevision: 1,
    });

    await expect(
      new ConnectorCatalogReadService(db, new MemoryConnectorSecretStore(db)).getSnapshot(
        connectorId,
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_NOT_PUBLISHED' });
  });
});
