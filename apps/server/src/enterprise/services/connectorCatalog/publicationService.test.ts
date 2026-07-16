// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload, PlatformRevisionConflictError } from '@/database/models/platform';
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
import type { ConnectorCatalogLifecycle, ConnectorCatalogSecretStore } from './catalogTypes';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { ConnectorCatalogDraftService } from './draftService';
import { PlatformConnectorContractError } from './errors';
import { ConnectorCatalogPublicationService } from './publicationService';

const db: LobeChatDatabase = await getTestDB();

beforeAll(() => ensurePendingM09ServiceSchema(db));
beforeEach(() => cleanupM09ServiceData(db));
afterEach(() => cleanupM09ServiceData(db));

const createHarness = (lifecycle: ConnectorCatalogLifecycle = {}) => {
  const secrets = new MemoryConnectorSecretStore(db);
  const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
  const assertAllowed = vi.fn(async (_url: string) => {});
  let policyVersion = 1;
  const preflight = vi.fn(async (url: string) => {
    await assertAllowed(url);
    return { policyVersion };
  });
  const getPolicyVersion = vi.fn(() => policyVersion);
  const outbound = {
    assertAllowed,
    getPolicyVersion,
    preflight,
  } as unknown as ConnectorOutboundClient;
  return {
    assertAllowed,
    drafts: new ConnectorCatalogDraftService(
      db,
      secrets,
      'https://aihub.example.test/oauth/callback',
    ),
    invalidation,
    publication: new ConnectorCatalogPublicationService(
      db,
      outbound,
      secrets,
      lifecycle,
      invalidation,
    ),
    read: new ConnectorCatalogReadService(db, secrets),
    secrets,
    setPolicyVersion: (version: number) => {
      policyVersion = version;
    },
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
  it('completes DNS and Secret resolution before locking with no external I/O afterward', async () => {
    const lifecycle: ConnectorCatalogLifecycle = {};
    const harness = createHarness(lifecycle);
    const resolve = vi.spyOn(harness.secrets, 'resolveSecretVersion');
    const draft = await createSharedDraft(harness, 'lock-scope-secret', 'lock-scope-connector');
    let callsAtLock: { preflight: number; resolve: number } | undefined;
    lifecycle.afterPublicationPreflight = async () => {
      callsAtLock = {
        preflight: harness.assertAllowed.mock.calls.length,
        resolve: resolve.mock.calls.length,
      };
    };

    await harness.publication.publish('admin-user', {
      expectedDraftToken: draft.draftToken,
      expectedRevision: 0,
      id: draft.draft.id,
      reason: 'publish connector',
    });
    expect(callsAtLock).toEqual({ preflight: 1, resolve: 1 });
    expect(harness.assertAllowed).toHaveBeenCalledTimes(callsAtLock!.preflight);
    expect(resolve).toHaveBeenCalledTimes(callsAtLock!.resolve);
  });

  it('fails with a stable conflict when outbound policy changes after preflight', async () => {
    const lifecycle: ConnectorCatalogLifecycle = {};
    const harness = createHarness(lifecycle);
    const draft = await createSharedDraft(harness, 'policy-proof-secret', 'policy-proof-connector');
    lifecycle.afterPublicationPreflight = async () => harness.setPolicyVersion(2);

    await expect(
      harness.publication.publish('admin-user', {
        expectedDraftToken: draft.draftToken,
        expectedRevision: 0,
        id: draft.draft.id,
        reason: 'publish connector',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(0);
  });

  it('rejects a rollback when the target checksum changes after preflight', async () => {
    const lifecycle: ConnectorCatalogLifecycle = {};
    const harness = createHarness(lifecycle);
    const draft = await createSharedDraft(harness, 'target-proof-secret', 'target-proof-connector');
    await harness.publication.publish('admin-user', {
      expectedDraftToken: draft.draftToken,
      expectedRevision: 0,
      id: draft.draft.id,
      reason: 'publish connector',
    });
    const published = await harness.drafts.getDraft(draft.draft.id);
    lifecycle.afterPublicationPreflight = async () => {
      await db
        .update(platformResourceRevisions)
        .set({ checksum: '0'.repeat(64) })
        .where(
          eq(
            platformResourceRevisions.id,
            (await db.select().from(platformResourceRevisions))[0]!.id,
          ),
        );
    };

    await expect(
      harness.publication.rollback('admin-user', {
        expectedDraftToken: published.draftToken,
        expectedRevision: 1,
        id: draft.draft.id,
        reason: 'restore connector',
        targetRevision: 1,
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(1);
  });

  it('rejects a checksum-valid historical revision containing a Secret reference', async () => {
    const harness = createHarness();
    const draft = await createSharedDraft(
      harness,
      'malicious-history-secret',
      'malicious-history-connector',
    );
    await harness.publication.publish('admin-user', {
      expectedDraftToken: draft.draftToken,
      expectedRevision: 0,
      id: draft.draft.id,
      reason: 'publish connector',
    });
    const published = await harness.drafts.getDraft(draft.draft.id);
    const [row] = await db.select().from(platformResourceRevisions);
    const malicious = structuredClone(row.payload) as Record<string, unknown>;
    (malicious.connector as Record<string, unknown>).description =
      'hidden vault://historical/revision';
    await db
      .update(platformResourceRevisions)
      .set({ checksum: checksumPayload(malicious), payload: malicious })
      .where(eq(platformResourceRevisions.id, row.id));

    await expect(
      harness.publication.rollback('admin-user', {
        expectedDraftToken: published.draftToken,
        expectedRevision: 1,
        id: draft.draft.id,
        reason: 'restore connector',
        targetRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_NOT_PUBLISHED' });
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(1);
  });

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

  it('preserves semantic apiKey/password property names in the strict revision projection', async () => {
    const secret = 'schema-aware-shared-secret';
    const harness = createHarness();
    const draft = await harness.drafts.createDraft('admin-user', {
      credentialMode: 'shared_service_account',
      displayName: 'Schema-aware Connector',
      enabled: true,
      endpoint: 'https://connector.example.test/mcp',
      key: 'schema-aware-connector',
      reason: 'create schema-aware connector',
      sharedSecret: { operation: 'replace', value: { apiKey: secret } },
      tools: [
        connectorToolFixture({
          inputSchema: {
            properties: {
              apiKey: { type: 'string' },
              password: { type: 'string' },
            },
            required: ['apiKey', 'password'],
            type: 'object',
          },
        }),
      ],
      transport: 'http',
    });
    await harness.publication.publish('admin-user', {
      expectedDraftToken: draft.draftToken,
      expectedRevision: 0,
      id: draft.draft.id,
      reason: 'publish schema-aware connector',
    });

    const [revision] = await db.select().from(platformResourceRevisions);
    const inputSchema = (
      revision.payload as { tools: Array<{ inputSchema: Record<string, unknown> }> }
    ).tools[0]!.inputSchema;
    expect(inputSchema).toMatchObject({
      properties: { apiKey: { type: 'string' }, password: { type: 'string' } },
      required: ['apiKey', 'password'],
    });
    expect(JSON.stringify(revision.payload)).not.toContain(secret);
  });

  it('publishes and rolls back exact OAuth endpoints without persisting client Secret material', async () => {
    const harness = createHarness();
    const firstSecret = 'oauth-client-secret-v1-never-persist';
    const secondSecret = 'oauth-client-secret-v2-never-persist';
    const first = await harness.drafts.createDraft('admin-user', {
      credentialMode: 'per_user_oauth',
      displayName: 'OAuth Connector',
      enabled: true,
      endpoint: 'https://oauth-connector-v1.example.test/mcp',
      key: 'oauth-connector',
      oauthClientSecret: { operation: 'replace', value: firstSecret },
      oauthConfig: {
        authorizationEndpoint: 'https://identity-v1.example.test/oauth/authorize',
        clientId: 'oauth-client-v1',
        issuer: 'https://identity-v1.example.test',
        scopes: ['openid', 'profile'],
        tokenEndpoint: 'https://identity-v1.example.test/oauth/token',
      },
      reason: 'create OAuth connector',
      tools: [connectorToolFixture()],
      transport: 'http',
    });
    await harness.publication.publish('admin-user', {
      expectedDraftToken: first.draftToken,
      expectedRevision: 0,
      id: first.draft.id,
      reason: 'publish OAuth v1',
    });
    const publishedV1 = await harness.drafts.getDraft(first.draft.id);
    const second = await harness.drafts.updateDraft('admin-user', {
      endpoint: 'https://oauth-connector-v2.example.test/mcp',
      expectedDraftToken: publishedV1.draftToken,
      expectedRevision: 1,
      id: first.draft.id,
      oauthClientSecret: { operation: 'replace', value: secondSecret },
      oauthConfig: {
        authorizationEndpoint: 'https://identity-v2.example.test/oauth/authorize',
        clientId: 'oauth-client-v2',
        issuer: 'https://identity-v2.example.test',
        scopes: ['openid'],
        tokenEndpoint: 'https://identity-v2.example.test/oauth/token',
      },
      reason: 'prepare OAuth v2',
    });
    await harness.publication.publish('admin-user', {
      expectedDraftToken: second.draftToken,
      expectedRevision: 2,
      id: first.draft.id,
      reason: 'publish OAuth v2',
    });
    const publishedV2 = await harness.drafts.getDraft(first.draft.id);
    await harness.publication.rollback('admin-user', {
      expectedDraftToken: publishedV2.draftToken,
      expectedRevision: 3,
      id: first.draft.id,
      reason: 'restore OAuth v1',
      targetRevision: 1,
    });

    const revisions = await db.select().from(platformResourceRevisions);
    const revisionJson = JSON.stringify(revisions);
    expect(revisionJson).toContain('authorizationEndpoint');
    expect(revisionJson).toContain('tokenEndpoint');
    expect(revisionJson).toContain('https://identity-v1.example.test/oauth/authorize');
    expect(revisionJson).not.toContain(firstSecret);
    expect(revisionJson).not.toContain(secondSecret);
    expect(revisionJson).not.toContain('vault://');
    const published = await harness.read.getAdminPublished(first.draft.id);
    expect(published).toMatchObject({
      oauthConfig: {
        authorizationEndpoint: 'https://identity-v1.example.test/oauth/authorize',
        clientId: 'oauth-client-v1',
        tokenEndpoint: 'https://identity-v1.example.test/oauth/token',
      },
      publishedRevision: 4,
    });
    const [connector] = await db.select().from(platformConnectors);
    expect(connector.oauthClientSecretFingerprint).toBe(first.draft.oauthClientSecret.fingerprint);
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
    harness.assertAllowed.mockImplementation(async (url: string) => {
      if (url.includes('connector-v1')) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SSRF_BLOCKED');
      }
    });
    await expect(
      harness.publication.rollback('admin-user', {
        expectedDraftToken: publishedV2.draftToken,
        expectedRevision: 3,
        id: first.draft.id,
        reason: 'blocked restore v1',
        targetRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_SSRF_BLOCKED' });
    await expect(harness.read.getTrustedPublished(first.draft.id)).resolves.toMatchObject({
      endpoint: 'https://connector-v2.example.test/mcp',
      publishedRevision: 3,
    });
    harness.assertAllowed.mockImplementation(async () => {});
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

  it('archives with the Published Secret fingerprint after the mutable Draft rotates', async () => {
    const harness = createHarness();
    const first = await createSharedDraft(harness, 'archive-secret-v1', 'archive-connector');
    await harness.publication.publish('admin-user', {
      expectedDraftToken: first.draftToken,
      expectedRevision: 0,
      id: first.draft.id,
      reason: 'publish archive v1',
    });
    const published = await harness.drafts.getDraft(first.draft.id);
    const rotated = await harness.drafts.updateDraft('admin-user', {
      expectedDraftToken: published.draftToken,
      expectedRevision: 1,
      id: first.draft.id,
      reason: 'rotate draft secret',
      sharedSecret: { operation: 'replace', value: { apiKey: 'archive-secret-v2' } },
    });
    await expect(
      harness.publication.archive('admin-user', {
        expectedDraftToken: rotated.draftToken,
        expectedRevision: 2,
        id: first.draft.id,
        reason: 'archive published v1',
      }),
    ).resolves.toMatchObject({ revision: 3 });
    const [connector] = await db.select().from(platformConnectors);
    expect(connector).toMatchObject({
      sharedSecretFingerprint: first.draft.sharedSecret.fingerprint,
      status: 'archived',
    });
  });

  it('maps Secret version resolver failures to one stable non-echo code', async () => {
    const harness = createHarness();
    const draft = await createSharedDraft(harness, 'resolver-secret', 'resolver-connector');
    await harness.publication.publish('admin-user', {
      expectedDraftToken: draft.draftToken,
      expectedRevision: 0,
      id: draft.draft.id,
      reason: 'publish connector',
    });
    const rawError = 'vault-backend-private-response';
    const failingSecrets: ConnectorCatalogSecretStore = {
      loadCurrentSecretSources: harness.secrets.loadCurrentSecretSources,
      persistSecret: harness.secrets.persistSecret,
      resolveSecretRef: harness.secrets.resolveSecretRef,
      resolveSecretVersion: async () => {
        throw new Error(rawError);
      },
    };
    try {
      await new ConnectorCatalogReadService(db, failingSecrets).getTrustedPublished(draft.draft.id);
      expect.unreachable('Secret resolver failure must reject');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED' });
      expect(JSON.stringify(error)).not.toContain(rawError);
    }
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
    const userIds = Array.from({ length: 101 }, (_, index) => `m09-service-user-${index}`);
    await db
      .insert(users)
      .values(userIds.map((id) => ({ id })))
      .onConflictDoNothing();
    await db.insert(platformUserConnectorBindings).values(
      userIds.map((userId, index) => ({
        connectedAt: new Date(),
        connectorId: draft.draft.id,
        id: `m09-service-binding-${index}`,
        oauthTokenRef: `vault://users/${userId}/token`,
        publishedRevision: 1,
        scopes: ['read'],
        status: 'connected' as const,
        tokenFingerprint: `binding-fingerprint-${index}`,
        userId,
      })),
    );
    const revokeSecret = vi.spyOn(harness.secrets, 'revokeSecretRef');
    await expect(
      harness.publication.revokeAllBindings('admin-user', {
        expectedRevision: 1,
        id: draft.draft.id,
        reason: 'revoke compromised grants',
      }),
    ).resolves.toMatchObject({ revoked: 101 });
    expect(revokeSecret).toHaveBeenCalledTimes(101);
    const revokedBindings = await db.select().from(platformUserConnectorBindings);
    expect(revokedBindings).toHaveLength(101);
    expect(revokedBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ oauthTokenRef: null, scopes: [], status: 'revoked' }),
      ]),
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
