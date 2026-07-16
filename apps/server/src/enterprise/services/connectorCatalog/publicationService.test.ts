// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformUserConnectorBindingRepository } from '@/database/repositories/platformConnectorCatalog';
import {
  platformConnectors,
  platformResourceRevisions,
  platformUserConnectorBindings,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';

import { InMemoryPlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { ConnectorCatalogReadService } from './catalogSnapshot';
import {
  cleanupM09ServiceData,
  connectorToolFixture,
  ensurePendingM09ServiceSchema,
  MemoryConnectorSecretStore,
} from './catalogTestUtils';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { ConnectorCatalogDraftService } from './draftService';
import { ConnectorCatalogPublicationService } from './publicationService';

const db: LobeChatDatabase = await getTestDB();

beforeAll(() => ensurePendingM09ServiceSchema(db));
beforeEach(() => cleanupM09ServiceData(db));
afterEach(() => cleanupM09ServiceData(db));

const createHarness = () => {
  const secrets = new MemoryConnectorSecretStore(db);
  const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
  const assertAllowed = vi.fn(async () => {});
  const outbound = { assertAllowed } as unknown as ConnectorOutboundClient;
  return {
    assertAllowed,
    drafts: new ConnectorCatalogDraftService(
      db,
      secrets,
      'https://aihub.example.test/oauth/callback',
    ),
    invalidation,
    publication: new ConnectorCatalogPublicationService(db, outbound, secrets, {}, invalidation),
    read: new ConnectorCatalogReadService(db, secrets),
    secrets,
  };
};

const createSharedDraft = async (
  harness: ReturnType<typeof createHarness>,
  secret: string,
  key = 'published-connector',
) =>
  harness.drafts.createDraft('admin-user', {
    credentialMode: 'shared_service_account',
    displayName: 'Published Connector',
    enabled: true,
    endpoint: 'https://connector-v1.example.test/mcp',
    key,
    reason: 'create connector',
    sharedSecret: { operation: 'replace', value: { apiKey: secret } },
    tools: [connectorToolFixture()],
    transport: 'http',
  });

describe('ConnectorCatalogPublicationService', () => {
  it('publishes a secret-free immutable payload and exposes separate public/trusted projections', async () => {
    const secret = 'published-shared-secret-v1';
    const harness = createHarness();
    const draft = await createSharedDraft(harness, secret);
    await expect(
      harness.publication.publish('admin-user', {
        expectedDraftToken: draft.draftToken,
        expectedRevision: 0,
        id: draft.draft.id,
        reason: 'publish connector',
      }),
    ).resolves.toMatchObject({ revision: 1 });

    expect(harness.assertAllowed).toHaveBeenCalledWith('https://connector-v1.example.test/mcp');
    const [revision] = await db.select().from(platformResourceRevisions);
    const revisionJson = JSON.stringify(revision.payload);
    expect(revisionJson).not.toContain(secret);
    expect(revisionJson).not.toContain('vault://');
    expect(revisionJson).toContain('sharedSecretFingerprint');

    const publicSnapshot = await harness.read.getPublicPublished(draft.draft.id);
    const publicJson = JSON.stringify(publicSnapshot);
    expect(publicJson).not.toContain(secret);
    expect(publicJson).not.toContain('connector-v1.example.test');
    expect(publicJson).not.toContain('inputSchema');
    await expect(harness.read.getTrustedPublished(draft.draft.id)).resolves.toMatchObject({
      credentialMode: 'shared_service_account',
      credentials: { apiKey: secret },
      publishedRevision: 1,
    });
    expect(harness.invalidation.events).toContainEqual(
      expect.objectContaining({
        resourceId: draft.draft.id,
        revision: 1,
        scopes: ['connector-catalog', 'connector-runtime'],
      }),
    );
  });

  it('rolls back endpoint, tools, and the exact historical Secret fingerprint', async () => {
    const harness = createHarness();
    const first = await createSharedDraft(harness, 'historical-secret-v1', 'rollback-connector');
    await harness.publication.publish('admin-user', {
      expectedDraftToken: first.draftToken,
      expectedRevision: 0,
      id: first.draft.id,
      reason: 'publish v1',
    });
    const publishedV1 = await harness.drafts.getDraft(first.draft.id);
    const updated = await harness.drafts.updateDraft('admin-user', {
      endpoint: 'https://connector-v2.example.test/mcp',
      expectedDraftToken: publishedV1.draftToken,
      expectedRevision: 1,
      id: first.draft.id,
      reason: 'prepare v2',
      sharedSecret: { operation: 'replace', value: { apiKey: 'historical-secret-v2' } },
    });
    await harness.publication.publish('admin-user', {
      expectedDraftToken: updated.draftToken,
      expectedRevision: 2,
      id: first.draft.id,
      reason: 'publish v2',
    });
    const publishedV2 = await harness.drafts.getDraft(first.draft.id);
    await expect(
      harness.publication.rollback('admin-user', {
        expectedDraftToken: publishedV2.draftToken,
        expectedRevision: 3,
        id: first.draft.id,
        reason: 'restore v1',
        targetRevision: 1,
      }),
    ).resolves.toMatchObject({ revision: 4 });

    await expect(harness.read.getTrustedPublished(first.draft.id)).resolves.toMatchObject({
      credentials: { apiKey: 'historical-secret-v1' },
      endpoint: 'https://connector-v1.example.test/mcp',
      publishedRevision: 4,
    });
    const [connector] = await db.select().from(platformConnectors);
    expect(connector.sharedSecretFingerprint).toBe(first.draft.sharedSecret.fingerprint);
  });

  it('revokes every binding with CAS/invalidation and archive removes the runtime snapshot', async () => {
    const harness = createHarness();
    const draft = await createSharedDraft(harness, 'revoke-secret', 'revoke-connector');
    await harness.publication.publish('admin-user', {
      expectedDraftToken: draft.draftToken,
      expectedRevision: 0,
      id: draft.draft.id,
      reason: 'publish connector',
    });
    await db.insert(users).values({ id: 'm09-service-user' }).onConflictDoNothing();
    await new PlatformUserConnectorBindingRepository(db, 'm09-service-user').upsertBinding({
      connectedAt: new Date(),
      connectorId: draft.draft.id,
      id: 'm09-service-binding',
      oauthTokenRef: 'vault://users/m09-service-user/token',
      publishedRevision: 1,
      scopes: ['read'],
      status: 'connected',
      tokenFingerprint: 'binding-fingerprint',
    });
    await expect(
      harness.publication.revokeAllBindings('admin-user', {
        expectedRevision: 1,
        id: draft.draft.id,
        reason: 'revoke compromised grants',
      }),
    ).resolves.toMatchObject({ revoked: 1 });
    expect(await db.select().from(platformUserConnectorBindings)).toContainEqual(
      expect.objectContaining({ oauthTokenRef: null, scopes: [], status: 'revoked' }),
    );
    expect(harness.invalidation.events.at(-1)).toMatchObject({
      revision: 1,
      scopes: ['connector-bindings', 'connector-runtime'],
    });

    const published = await harness.drafts.getDraft(draft.draft.id);
    await harness.publication.archive('admin-user', {
      expectedDraftToken: published.draftToken,
      expectedRevision: 1,
      id: draft.draft.id,
      reason: 'archive connector',
    });
    await expect(harness.read.getTrustedPublished(draft.draft.id)).rejects.toMatchObject({
      code: 'PLATFORM_CONNECTOR_NOT_PUBLISHED',
    });
  });
});
