// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  PlatformConnectorCatalogRepository,
  type PlatformConnectorRevisionPayload,
} from '@/database/repositories/platformConnectorCatalog';
import { platformConnectors, platformResourceRevisions } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  clearConnectorCatalogRuntimeCache,
  ConnectorCatalogReadService,
  parseConnectorRevisionPayload,
} from './catalogSnapshot';
import { cleanupM09ServiceData, MemoryConnectorSecretStore } from './catalogTestUtils';

const db: LobeChatDatabase = await getTestDB();
const connectorId = 'm09-snapshot-connector';

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
  it('recursively rejects Secret references in every revision metadata region', () => {
    const mutations: Array<(candidate: PlatformConnectorRevisionPayload) => void> = [
      (candidate) => {
        candidate.connector.description = 'embedded vault://connector/description';
      },
      (candidate) => {
        candidate.tools[0]!.description = 'embedded KMS://connector/tool';
      },
      (candidate) => {
        candidate.connector.sharedSecretFingerprint = 'vault://connector/fingerprint';
      },
      (candidate) => {
        candidate.connector.oauthConfig = {
          authorizationEndpoint: 'https://identity.example.test/authorize',
          clientId: 'client',
          issuer: 'https://identity.example.test',
          redirectUri: 'https://aihub.example.test/oauth/callback',
          scopes: ['vault://connector/scope'],
          tokenEndpoint: 'https://identity.example.test/token',
        };
      },
      (candidate) => {
        candidate.tools[0]!.inputSchema = {
          properties: { query: { description: '%76ault%3A%2F%2Fschema', type: 'string' } },
        };
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(payload('https://safe.example.test/mcp'));
      mutate(candidate);
      expect(() => parseConnectorRevisionPayload(candidate)).toThrowError(
        'PLATFORM_CONNECTOR_NOT_PUBLISHED',
      );
    }
  });

  it('fails closed for checksum-valid malicious revisions across cache and all projections', async () => {
    const repository = await seedConnector();
    const malicious = payload('https://malicious-snapshot.example.test/mcp');
    malicious.connector.description = 'hidden vault://connector/revision';
    const checksum = checksumPayload(malicious);
    await repository.createPublishedRevision({
      checksum,
      connectorId,
      payload: malicious,
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

    for (const operation of [
      () => read.getSnapshot(connectorId),
      () => read.getAdminPublished(connectorId),
      () => read.getPublicPublished(connectorId),
      () => read.getTrustedPublished(connectorId),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: 'PLATFORM_CONNECTOR_NOT_PUBLISHED',
      });
    }
    // The BATCH must fail closed per-id — drop the malicious row to null, never leak or throw.
    await expect(read.getAdminPublishedBatch([connectorId])).resolves.toEqual({
      items: [{ connectorId, published: null }],
    });
  });

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

  it('exposes the exact published checksum on the ADMIN projection only (public/runtime hidden)', async () => {
    const repository = await seedConnector();
    const revision = payload('https://checksum.example.test/mcp');
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

    // Admin projection: the checksum is present AND exactly the published revision provenance
    // checksum the agent dependency validator compares against — never a fabricated value.
    const admin = await read.getAdminPublished(connectorId);
    expect(admin.publishedChecksum).toBe(checksum);
    expect(admin.publishedChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(admin.publishedRevision).toBe(1);

    // Public + runtime/trusted projections remain unchanged — the checksum stays hidden.
    const publicSnapshot = await read.getPublicPublished(connectorId);
    expect(publicSnapshot).not.toHaveProperty('publishedChecksum');
    const trusted = await read.getTrustedPublished(connectorId);
    expect(trusted).not.toHaveProperty('publishedChecksum');
  });

  it('batch-projects the exact published tuple per id and returns null for unpublished ids', async () => {
    const repository = await seedConnector();
    const revision = payload('https://batch.example.test/mcp');
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

    // One batch call, mixed published + never-published id; order matches the requested ids.
    const batch = await read.getAdminPublishedBatch([connectorId, 'connector-not-published']);
    expect(batch.items).toEqual([
      {
        connectorId,
        published: {
          connectorId,
          connectorKey: 'snapshot-connector',
          publishedChecksum: checksum,
          publishedRevision: 1,
          tools: [{ platformPolicy: 'allow', toolKey: 'search.v1' }],
        },
      },
      { connectorId: 'connector-not-published', published: null },
    ]);
    // The compact batch item never carries endpoint / OAuth / secret metadata.
    expect(batch.items[0]!.published).not.toHaveProperty('endpoint');
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
    // Test-only bypass of the immutable-revision trigger (migration 0145).
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL session_replication_role = 'replica'`));
      await tx
        .update(platformResourceRevisions)
        .set({ payload: payload('https://tampered-after-cache.example.test/mcp') })
        .where(eq(platformResourceRevisions.id, row.id));
    });

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

  it('accepts already-stored shared credentials whose header names fail the write-time RFC token grammar', async () => {
    // Pre-token-rule vaults could store space/colon/non-ASCII names. Trusted
    // published resolution must not hard-fail so admins can replace the secret
    // (detail API is presence-only — values are not projected for display).
    const legacyCredential = {
      headers: {
        'Bad Header': 'space-name',
        'X-Key:Sub': 'colon-name',
        'X-键': 'non-ascii-name',
      },
    };
    const secrets = new MemoryConnectorSecretStore(db);
    const repository = new PlatformConnectorCatalogRepository(db);
    await repository.createConnector({
      connectorKey: 'legacy-headers-connector',
      credentialMode: 'shared_service_account',
      displayName: 'Legacy Headers',
      endpoint: 'https://legacy-headers.example.test/mcp',
      id: connectorId,
      status: 'draft',
    });
    const stored = await secrets.persistSecret({
      connectorId,
      slot: 'sharedSecret',
      value: legacyCredential,
    });
    await db
      .update(platformConnectors)
      .set({
        sharedSecretFingerprint: stored.fingerprint,
        sharedSecretRef: stored.ref,
        sharedSecretUpdatedAt: stored.updatedAt,
      })
      .where(eq(platformConnectors.id, connectorId));

    const revision: PlatformConnectorRevisionPayload = {
      connector: {
        credentialMode: 'shared_service_account',
        description: null,
        displayName: 'Legacy Headers',
        enabled: true,
        endpoint: 'https://legacy-headers.example.test/mcp',
        id: connectorId,
        key: 'legacy-headers-connector',
        oauthClientSecretConfigured: false,
        oauthClientSecretFingerprint: null,
        oauthConfig: null,
        sharedSecretConfigured: true,
        sharedSecretFingerprint: stored.fingerprint,
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
    };
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

    const read = new ConnectorCatalogReadService(db, secrets);
    await expect(read.getTrustedPublished(connectorId)).resolves.toMatchObject({
      credentialMode: 'shared_service_account',
      credentials: legacyCredential,
      endpoint: 'https://legacy-headers.example.test/mcp',
    });
  });
});
