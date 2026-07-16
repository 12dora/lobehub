// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  PlatformConnectorCatalogRepository,
  type PlatformConnectorRevisionPayload,
} from '@/database/repositories/platformConnectorCatalog';
import { platformConnectors } from '@/database/schemas/platform';
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
  tools: [],
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
