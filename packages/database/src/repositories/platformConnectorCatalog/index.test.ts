// @vitest-environment node
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  platformConnectorOAuthStates,
  platformConnectors,
  platformConnectorTools,
  platformResourceRevisions,
  platformUserConnectorBindings,
} from '../../schemas/platform';
import type {
  PlatformConnectorOAuthConfig,
  PlatformConnectorToolJsonSchema,
  PlatformUserConnectorBindingItem,
} from '../../schemas/platform/connectors';
import { users } from '../../schemas/user';
import type { LobeChatDatabase } from '../../type';
import {
  MAX_PLATFORM_CONNECTOR_TOOLS,
  PlatformConnectorCatalogRepository,
  type PlatformConnectorRevisionPayload,
  PlatformUserConnectorBindingRepository,
} from '.';

const serverDB: LobeChatDatabase = await getTestDB();
const catalog = new PlatformConnectorCatalogRepository(serverDB);

const connectorPrefix = 'm09-test-';
const userIds = ['m09-user-a', 'm09-user-b', 'm09-user-c', 'm09-user-d'];

const cleanup = async () => {
  await serverDB
    .delete(platformConnectorOAuthStates)
    .where(
      or(
        sql`${platformConnectorOAuthStates.id} LIKE 'm09-%'`,
        inArray(platformConnectorOAuthStates.userId, userIds),
      ),
    );
  await serverDB
    .delete(platformUserConnectorBindings)
    .where(inArray(platformUserConnectorBindings.userId, userIds));
  await serverDB
    .delete(platformConnectorTools)
    .where(sql`${platformConnectorTools.connectorId} LIKE ${`${connectorPrefix}%`}`);
  await serverDB
    .delete(platformConnectors)
    .where(sql`${platformConnectors.id} LIKE ${`${connectorPrefix}%`}`);
  await serverDB
    .delete(platformResourceRevisions)
    .where(
      and(
        eq(platformResourceRevisions.resourceType, 'connector'),
        sql`${platformResourceRevisions.resourceId} LIKE ${`${connectorPrefix}%`}`,
      ),
    );
  await serverDB.delete(users).where(inArray(users.id, userIds));
};

const createConnector = async (
  suffix: string,
  credentialMode: 'none' | 'per_user_oauth' = 'none',
) =>
  catalog.createConnector({
    connectorKey: `${connectorPrefix}${suffix}`,
    credentialMode,
    displayName: `Connector ${suffix}`,
    endpoint: 'https://connector.example.test/mcp',
    id: `${connectorPrefix}${suffix}`,
    oauthClientSecretRef:
      credentialMode === 'per_user_oauth' ? `vault://connectors/${suffix}/client-secret` : null,
    oauthClientSecretFingerprint: credentialMode === 'per_user_oauth' ? `sha256:${suffix}` : null,
    oauthClientSecretUpdatedAt:
      credentialMode === 'per_user_oauth' ? new Date('2026-07-17T00:00:00Z') : null,
    oauthConfig:
      credentialMode === 'per_user_oauth'
        ? {
            authorizationEndpoint: 'https://id.example.test/authorize',
            clientId: 'm09-client',
            issuer: 'https://id.example.test',
            redirectUri: 'https://aihub.example.test/oauth/callback',
            scopes: ['read'],
            tokenEndpoint: 'https://id.example.test/token',
          }
        : null,
  });

const revisionPayload = (connectorId: string): PlatformConnectorRevisionPayload => ({
  connector: {
    credentialMode: 'none',
    description: null,
    displayName: 'Published connector',
    enabled: true,
    endpoint: 'https://connector.example.test/mcp',
    id: connectorId,
    key: connectorId,
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

const ensurePublishedRevision = async (connectorId: string, revision = 1) => {
  await serverDB
    .insert(platformResourceRevisions)
    .values({
      checksum: String(revision).padStart(64, '0'),
      payload: revisionPayload(connectorId),
      publishedAt: new Date(),
      publishedBy: userIds[0],
      resourceId: connectorId,
      resourceType: 'connector',
      revision,
      status: 'published',
    })
    .onConflictDoNothing();
};

const createBinding = async (userId: string, connectorId: string, id: string) => {
  await ensurePublishedRevision(connectorId);
  const repository = new PlatformUserConnectorBindingRepository(serverDB, userId);
  return repository.upsertBinding({
    connectorId,
    id,
    oauthTokenRef: `vault://users/${userId}/connectors/${connectorId}/token`,
    publishedRevision: 1,
    scopes: ['read'],
    status: 'connected',
    tokenFingerprint: `sha256:${userId}`,
    connectedAt: new Date('2026-07-17T00:00:00Z'),
  });
};

const createPublishedOAuthConnector = async (suffix: string) => {
  const connector = await createConnector(suffix, 'per_user_oauth');
  await ensurePublishedRevision(connector.id);
  await catalog.setPublishedPointerCas({
    checksum: '1'.padStart(64, '0'),
    connectorId: connector.id,
    expectedRevision: 0,
    publishedAt: new Date(),
    publishedRevision: 1,
  });
  await serverDB
    .update(platformConnectors)
    .set({ enabled: true })
    .where(eq(platformConnectors.id, connector.id));
  return connector;
};

beforeEach(async () => {
  await cleanup();
  await serverDB.insert(users).values(userIds.map((id) => ({ id })));
});
afterAll(cleanup);

describe('pending M09 database constraints', () => {
  it('rejects incomplete credential triples and nested OAuth secret keys', async () => {
    await expect(
      catalog.createConnector({
        connectorKey: `${connectorPrefix}none-with-fingerprint`,
        credentialMode: 'none',
        displayName: 'Invalid none',
        endpoint: 'https://connector.example.test/mcp',
        id: `${connectorPrefix}none-with-fingerprint`,
        sharedSecretFingerprint: 'sha256:orphan',
      }),
    ).rejects.toThrow();
    await expect(
      catalog.createConnector({
        connectorKey: `${connectorPrefix}shared-incomplete`,
        credentialMode: 'shared_service_account',
        displayName: 'Invalid shared',
        endpoint: 'https://connector.example.test/mcp',
        id: `${connectorPrefix}shared-incomplete`,
        sharedSecretRef: 'vault://connectors/incomplete',
      }),
    ).rejects.toThrow();
    const oauthConfig = {
      authorizationEndpoint: 'https://id.example.test/authorize',
      clientId: 'm09-client',
      issuer: 'https://id.example.test',
      nested: { clientSecret: 'must-never-enter-json' },
      redirectUri: 'https://aihub.example.test/oauth/callback',
      scopes: ['read'],
      tokenEndpoint: 'https://id.example.test/token',
    } as unknown as PlatformConnectorOAuthConfig;
    await expect(
      catalog.createConnector({
        connectorKey: `${connectorPrefix}oauth-sensitive-json`,
        credentialMode: 'per_user_oauth',
        displayName: 'Invalid OAuth JSON',
        endpoint: 'https://connector.example.test/mcp',
        id: `${connectorPrefix}oauth-sensitive-json`,
        oauthConfig,
      }),
    ).rejects.toThrow();
  });

  it('rejects zero/non-hex and cross-revision publication pointers', async () => {
    const connector = await createConnector('invalid-pointer');
    const publishedAt = new Date('2026-07-17T00:00:00Z');
    await catalog.createPublishedRevision({
      checksum: 'a'.repeat(64),
      connectorId: connector.id,
      payload: revisionPayload(connector.id),
      publishedAt,
      publishedBy: userIds[0],
      revision: 1,
    });
    await catalog.createPublishedRevision({
      checksum: 'b'.repeat(64),
      connectorId: connector.id,
      payload: revisionPayload(connector.id),
      publishedAt,
      publishedBy: userIds[0],
      revision: 2,
    });

    await expect(
      serverDB
        .update(platformConnectors)
        .set({
          publishedAt,
          publishedChecksum: 'not-a-checksum',
          publishedRevision: 0,
          status: 'published',
        })
        .where(eq(platformConnectors.id, connector.id)),
    ).rejects.toThrow();
    await expect(
      serverDB
        .update(platformConnectors)
        .set({
          publishedAt,
          publishedChecksum: 'b'.repeat(64),
          publishedRevision: 1,
          status: 'published',
        })
        .where(eq(platformConnectors.id, connector.id)),
    ).rejects.toThrow();
  });

  it('accepts every valid binding state and rejects inconsistent terminal/token fields', async () => {
    const connector = await createConnector('binding-matrix', 'per_user_oauth');
    await ensurePublishedRevision(connector.id);
    const base = {
      connectorId: connector.id,
      publishedRevision: 1,
      userId: userIds[0],
    };
    const validStates: Array<
      Pick<
        PlatformUserConnectorBindingItem,
        'connectedAt' | 'oauthTokenRef' | 'revokedAt' | 'scopes' | 'status' | 'tokenFingerprint'
      >
    > = [
      {
        connectedAt: null,
        oauthTokenRef: null,
        revokedAt: null,
        scopes: [],
        status: 'disconnected',
        tokenFingerprint: null,
      },
      {
        connectedAt: null,
        oauthTokenRef: null,
        revokedAt: null,
        scopes: [],
        status: 'pending',
        tokenFingerprint: null,
      },
      {
        connectedAt: new Date('2026-07-17T00:00:00Z'),
        oauthTokenRef: 'vault://users/m09/token',
        revokedAt: null,
        scopes: ['read'],
        status: 'connected',
        tokenFingerprint: 'sha256:connected',
      },
      {
        connectedAt: new Date('2026-07-17T00:00:00Z'),
        oauthTokenRef: 'kms://users/m09/expired-token',
        revokedAt: null,
        scopes: ['read'],
        status: 'expired',
        tokenFingerprint: 'sha256:expired',
      },
      {
        connectedAt: new Date('2026-07-17T00:00:00Z'),
        oauthTokenRef: null,
        revokedAt: new Date('2026-07-17T00:05:00Z'),
        scopes: [],
        status: 'revoked',
        tokenFingerprint: null,
      },
      {
        connectedAt: null,
        oauthTokenRef: null,
        revokedAt: null,
        scopes: [],
        status: 'error',
        tokenFingerprint: null,
      },
    ];
    for (const [index, state] of validStates.entries()) {
      const id = `m09-matrix-${index}`;
      await expect(
        serverDB.insert(platformUserConnectorBindings).values({ ...base, ...state, id }),
      ).resolves.toBeDefined();
      await serverDB
        .delete(platformUserConnectorBindings)
        .where(eq(platformUserConnectorBindings.id, id));
    }

    await expect(
      serverDB.insert(platformUserConnectorBindings).values({
        ...base,
        id: 'm09-matrix-connected-missing-fingerprint',
        oauthTokenRef: 'vault://users/m09/token',
        scopes: ['read'],
        status: 'connected',
        connectedAt: new Date('2026-07-17T00:00:00Z'),
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformUserConnectorBindings).values({
        ...base,
        id: 'm09-matrix-revoked-missing-time',
        scopes: [],
        status: 'revoked',
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformUserConnectorBindings).values({
        ...base,
        id: 'm09-matrix-zero-revision',
        publishedRevision: 0,
        scopes: [],
        status: 'disconnected',
      }),
    ).rejects.toThrow();
  });

  it('enforces OAuth owner/revision identity and the (0, 10 minute] TTL boundary', async () => {
    const connector = await createConnector('oauth-constraints', 'per_user_oauth');
    await ensurePublishedRevision(connector.id);
    const bindingA = await new PlatformUserConnectorBindingRepository(
      serverDB,
      userIds[0],
    ).upsertBinding({
      connectorId: connector.id,
      id: 'm09-constraint-binding-a',
      publishedRevision: 1,
      scopes: [],
      status: 'pending',
    });
    await new PlatformUserConnectorBindingRepository(serverDB, userIds[1]).upsertBinding({
      connectorId: connector.id,
      id: 'm09-constraint-binding-b',
      publishedRevision: 1,
      scopes: [],
      status: 'pending',
    });
    const createdAt = new Date('2026-07-17T00:00:00Z');
    const stateBase = {
      bindingId: bindingA.id,
      connectorId: connector.id,
      createdAt,
      pkceVerifierRef: 'vault://oauth/constraint/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      scopes: ['read'],
      userId: userIds[0],
    };

    await expect(
      serverDB.insert(platformConnectorOAuthStates).values({
        ...stateBase,
        expiresAt: new Date('2026-07-17T00:10:00Z'),
        id: 'm09-state-cross-owner',
        stateHash: '1'.repeat(64),
        stateId: 'm09-state-cross-owner',
        userId: userIds[1],
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformConnectorOAuthStates).values({
        ...stateBase,
        expiresAt: new Date('2026-07-17T00:10:00Z'),
        id: 'm09-state-cross-revision',
        publishedRevision: 2,
        stateHash: '2'.repeat(64),
        stateId: 'm09-state-cross-revision',
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformConnectorOAuthStates).values({
        ...stateBase,
        expiresAt: createdAt,
        id: 'm09-state-zero-ttl',
        stateHash: '3'.repeat(64),
        stateId: 'm09-state-zero-ttl',
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformConnectorOAuthStates).values({
        ...stateBase,
        expiresAt: new Date('2026-07-17T00:10:00.001Z'),
        id: 'm09-state-long-ttl',
        stateHash: '4'.repeat(64),
        stateId: 'm09-state-long-ttl',
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformConnectorOAuthStates).values({
        ...stateBase,
        expiresAt: new Date('2026-07-17T00:10:00Z'),
        id: 'm09-state-max-ttl',
        stateHash: '5'.repeat(64),
        stateId: 'm09-state-max-ttl',
      }),
    ).resolves.toBeDefined();
  });

  it('rejects non-object/oversized tool schemas and unsafe confirmation settings', async () => {
    const connector = await createConnector('tool-constraints');
    await expect(
      serverDB.insert(platformConnectorTools).values({
        connectorId: connector.id,
        displayName: 'Array input',
        id: 'm09-tool-array-input',
        inputSchema: [] as unknown as PlatformConnectorToolJsonSchema,
        toolKey: 'array-input',
      }),
    ).rejects.toThrow();
    await expect(
      serverDB.insert(platformConnectorTools).values({
        connectorId: connector.id,
        displayName: 'Large output',
        id: 'm09-tool-large-output',
        outputSchema: {
          description: 'x'.repeat(65_536),
          type: 'object',
        },
        toolKey: 'large-output',
      }),
    ).rejects.toThrow();
    for (const riskLevel of ['high', 'critical'] as const) {
      await expect(
        serverDB.insert(platformConnectorTools).values({
          connectorId: connector.id,
          displayName: `Unsafe ${riskLevel}`,
          id: `m09-tool-unsafe-${riskLevel}`,
          requiresConfirmation: false,
          riskLevel,
          toolKey: `unsafe-${riskLevel}`,
        }),
      ).rejects.toThrow();
    }
    await expect(
      serverDB.insert(platformConnectorTools).values({
        connectorId: connector.id,
        displayName: 'Low risk',
        id: 'm09-tool-low-risk',
        requiresConfirmation: false,
        riskLevel: 'low',
        toolKey: 'low-risk',
      }),
    ).resolves.toBeDefined();
  });
});

describe('PlatformConnectorCatalogRepository', () => {
  it('dual-writes non-secret M01 shadows while keeping legacy secret columns empty', async () => {
    const connector = await createConnector('legacy-shadow');
    expect(connector).toMatchObject({
      legacyConnectionType: 'http',
      legacyEncryptedSharedCredentials: null,
      legacyIsRequired: false,
      legacyMcpServerUrl: connector.endpoint,
      legacyName: connector.displayName,
      legacyOidcConfig: null,
      legacySecretFingerprint: null,
      legacySourceType: 'custom',
    });

    const [tool] = await catalog.replaceTools(connector.id, [
      {
        description: 'Compatibility tool',
        displayName: 'Compatibility tool',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        toolKey: 'compatibility',
      },
    ]);
    expect(tool).toMatchObject({
      legacyAllowUserStricterPolicy: true,
      legacyManifest: expect.objectContaining({ name: 'compatibility' }),
      legacyPermissionPolicy: 'needs_approval',
    });
  });

  it('bounds connector pagination and uses a stable composite cursor', async () => {
    await serverDB.insert(platformConnectors).values(
      Array.from({ length: 101 }, (_, index) => ({
        connectorKey: `${connectorPrefix}page-${String(index).padStart(3, '0')}`,
        credentialMode: 'none' as const,
        displayName: `Page ${index}`,
        endpoint: 'https://connector.example.test/mcp',
        id: `${connectorPrefix}page-${String(index).padStart(3, '0')}`,
        legacyName: `Page ${index}`,
        migrationRequired: false,
      })),
    );
    await serverDB.insert(platformConnectors).values({
      connectorKey: `${connectorPrefix}legacy-isolated`,
      credentialMode: 'none',
      displayName: 'Legacy isolated',
      id: `${connectorPrefix}legacy-isolated`,
      legacyName: 'Legacy isolated',
      migrationRequired: true,
    });

    const first = await catalog.listConnectors({ limit: 10_000 });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toEqual({
      connectorKey: `${connectorPrefix}page-099`,
      id: `${connectorPrefix}page-099`,
    });
    const second = await catalog.listConnectors({ cursor: first.nextCursor!, limit: 100 });
    expect(second.items.map((item) => item.id)).toEqual([`${connectorPrefix}page-100`]);
    expect(second.nextCursor).toBeNull();
    await expect(
      catalog.getConnectorByKey(`${connectorPrefix}legacy-isolated`),
    ).resolves.toBeUndefined();
  });

  it('replaces tools with deterministic pagination and enforces the hard bound', async () => {
    const connector = await createConnector('tools');
    await catalog.replaceTools(connector.id, [
      { displayName: 'Zulu', id: 'm09-tool-z', sort: 2, toolKey: 'zulu' },
      { displayName: 'Alpha', id: 'm09-tool-a', sort: 1, toolKey: 'alpha' },
      { displayName: 'Beta', id: 'm09-tool-b', sort: 1, toolKey: 'beta' },
    ]);

    const first = await catalog.listTools({ connectorId: connector.id, limit: 2 });
    expect(first.items.map((item) => item.toolKey)).toEqual(['alpha', 'beta']);
    const second = await catalog.listTools({
      connectorId: connector.id,
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect(second.items.map((item) => item.toolKey)).toEqual(['zulu']);
    await expect(
      catalog.replaceTools(
        connector.id,
        Array.from({ length: MAX_PLATFORM_CONNECTOR_TOOLS + 1 }, (_, index) => ({
          displayName: `Tool ${index}`,
          toolKey: `tool-${index}`,
        })),
      ),
    ).rejects.toThrow('PLATFORM_CONNECTOR_TOOL_LIMIT_EXCEEDED');

    await expect(
      catalog.replaceTools(connector.id, [
        { displayName: 'Duplicate A', id: 'm09-tool-duplicate-a', toolKey: 'duplicate' },
        { displayName: 'Duplicate B', id: 'm09-tool-duplicate-b', toolKey: 'duplicate' },
      ]),
    ).rejects.toThrow();
    const afterRollback = await catalog.listTools({ connectorId: connector.id, limit: 100 });
    expect(afterRollback.items.map((item) => item.toolKey)).toEqual(['alpha', 'beta', 'zulu']);
  });

  it('batch-loads connectors and tools with single-query helpers', async () => {
    const a = await createConnector('batch-a');
    const b = await createConnector('batch-b');
    await catalog.replaceTools(a.id, [
      { displayName: 'A1', id: 'm09-tool-batch-a1', sort: 0, toolKey: 'a1' },
    ]);
    await catalog.replaceTools(b.id, [
      { displayName: 'B1', id: 'm09-tool-batch-b1', sort: 0, toolKey: 'b1' },
      { displayName: 'B2', id: 'm09-tool-batch-b2', sort: 1, toolKey: 'b2' },
    ]);

    const connectors = await catalog.getConnectorsByIds([a.id, b.id, `${connectorPrefix}missing`]);
    expect(connectors.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());

    const tools = await catalog.listToolsForConnectors([a.id, b.id]);
    expect(tools).toHaveLength(3);
    expect(tools.filter((t) => t.connectorId === b.id).map((t) => t.toolKey)).toEqual(['b1', 'b2']);
    expect(await catalog.listToolsForConnectors([])).toEqual([]);
  });

  it('serializes concurrent full replacements under the connector row lock', async () => {
    const connector = await createConnector('tools-concurrent');
    const replacementA = [
      { displayName: 'A1', id: 'm09-tool-a1', toolKey: 'a1' },
      { displayName: 'A2', id: 'm09-tool-a2', toolKey: 'a2' },
    ];
    const replacementB = [
      { displayName: 'B1', id: 'm09-tool-b1', toolKey: 'b1' },
      { displayName: 'B2', id: 'm09-tool-b2', toolKey: 'b2' },
    ];

    await Promise.all([
      catalog.replaceTools(connector.id, replacementA),
      catalog.replaceTools(connector.id, replacementB),
    ]);
    const result = await catalog.listTools({ connectorId: connector.id, limit: 100 });
    expect([
      ['a1', 'a2'],
      ['b1', 'b2'],
    ]).toContainEqual(result.items.map((tool) => tool.toolKey));
    await expect(catalog.replaceTools('m09-test-missing', replacementA)).rejects.toThrow(
      'PLATFORM_CONNECTOR_NOT_FOUND',
    );
  });

  it('uses CAS and resolves runtime from the exact immutable published revision', async () => {
    const connector = await createConnector('runtime');
    const publishedAt = new Date('2026-07-17T00:00:00Z');
    const payload = revisionPayload(connector.id);
    const revision = await catalog.createPublishedRevision({
      checksum: 'a'.repeat(64),
      connectorId: connector.id,
      payload,
      publishedAt,
      publishedBy: userIds[0],
      revision: 1,
    });
    await catalog.createPublishedRevision({
      checksum: 'b'.repeat(64),
      connectorId: connector.id,
      payload: { ...payload, schemaVersion: 'm09-v1' },
      publishedAt,
      publishedBy: userIds[0],
      revision: 2,
    });

    const published = await catalog.setPublishedPointerCas({
      checksum: 'a'.repeat(64),
      connectorId: connector.id,
      expectedRevision: 0,
      publishedAt,
      publishedRevision: 1,
    });
    expect(published?.revision).toBe(1);
    await expect(
      catalog.setPublishedPointerCas({
        checksum: 'b'.repeat(64),
        connectorId: connector.id,
        expectedRevision: 0,
        publishedAt,
        publishedRevision: 2,
      }),
    ).resolves.toBeUndefined();

    const runtime = await catalog.getCurrentPublishedRuntime(connector.id);
    expect(runtime).toEqual({
      payload,
      provenance: {
        checksum: 'a'.repeat(64),
        connectorId: connector.id,
        publishedAt,
        revision: 1,
        revisionId: revision.id,
      },
    });
    await expect(catalog.getPublishedRuntimeRevision(connector.id, 2)).resolves.toMatchObject({
      provenance: { checksum: 'b'.repeat(64), connectorId: connector.id, revision: 2 },
    });
    const exactBatch = await catalog.getPublishedRuntimeRevisionsExact([
      { connectorId: connector.id, publishedRevision: 1 },
      { connectorId: connector.id, publishedRevision: 2 },
      { connectorId: connector.id, publishedRevision: 99 },
    ]);
    expect(exactBatch.get(`${connector.id}\0${1}`)?.provenance.revisionId).toBe(revision.id);
    expect(exactBatch.get(`${connector.id}\0${2}`)?.provenance.checksum).toBe('b'.repeat(64));
    expect(exactBatch.has(`${connector.id}\0${99}`)).toBe(false);
    await expect(
      serverDB
        .update(platformConnectors)
        .set({ publishedChecksum: 'b'.repeat(64) })
        .where(eq(platformConnectors.id, connector.id)),
    ).rejects.toThrow();
    await expect(catalog.getCurrentPublishedRuntime(connector.id)).resolves.toEqual(runtime);
  });

  it('atomically consumes a live OAuth state only once under concurrency', async () => {
    const connector = await createConnector('oauth-state', 'per_user_oauth');
    const binding = await createBinding(userIds[0], connector.id, 'm09-binding-state');
    const userRepository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    const stateHash = 'c'.repeat(64);
    await userRepository.createOAuthState({
      bindingId: binding.id,
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      id: 'm09-oauth-state',
      pkceVerifierRef: 'vault://oauth/state/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      stateHash,
      stateId: 'm09-state-id',
    });

    const attempts = await Promise.all([
      catalog.reserveOAuthState(stateHash),
      catalog.reserveOAuthState(stateHash),
    ]);
    const reserved = attempts.filter((attempt) => attempt.status === 'reserved');
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toMatchObject({
      status: 'reserved',
      state: {
        consumedAt: expect.any(Date),
        id: 'm09-oauth-state',
      },
    });
    await expect(catalog.reserveOAuthState(stateHash)).resolves.toMatchObject({
      status: 'replayed',
    });
  });

  it('terminates expired OAuth states and rejects already revoked states', async () => {
    const connector = await createConnector('oauth-terminal', 'per_user_oauth');
    const binding = await createBinding(userIds[0], connector.id, 'm09-binding-terminal');
    const createdAt = new Date(Date.now() - 10 * 60 * 1000);
    await serverDB.insert(platformConnectorOAuthStates).values({
      bindingId: binding.id,
      connectorId: connector.id,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 5 * 60 * 1000),
      id: 'm09-expired-state',
      pkceVerifierRef: 'vault://oauth/expired/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      stateHash: 'e'.repeat(64),
      stateId: 'm09-expired-state-id',
      userId: userIds[0],
    });
    await serverDB.insert(platformConnectorOAuthStates).values({
      bindingId: binding.id,
      connectorId: connector.id,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 6 * 60 * 1000),
      id: 'm09-revoked-state',
      pkceVerifierRef: 'kms://oauth/revoked/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      revokedAt: new Date(createdAt.getTime() + 60_000),
      stateHash: 'f'.repeat(64),
      stateId: 'm09-revoked-state-id',
      userId: userIds[0],
    });

    await expect(catalog.reserveOAuthState('e'.repeat(64))).resolves.toMatchObject({
      status: 'expired',
    });
    await expect(catalog.reserveOAuthState('f'.repeat(64))).resolves.toMatchObject({
      status: 'invalid',
    });
    const rows = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(inArray(platformConnectorOAuthStates.id, ['m09-expired-state', 'm09-revoked-state']));
    expect(rows.every((row) => row.consumedAt === null && row.revokedAt instanceof Date)).toBe(
      true,
    );
  });

  it('keeps OAuth state target revision independent while a binding upgrades', async () => {
    const connector = await createConnector('oauth-revision-upgrade', 'per_user_oauth');
    const binding = await createBinding(userIds[0], connector.id, 'm09-binding-revision-upgrade');
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    await repository.createOAuthState({
      bindingId: binding.id,
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      id: 'm09-state-revision-one',
      pkceVerifierRef: 'vault://oauth/revision-one/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      stateHash: 'b'.repeat(64),
      stateId: 'm09-state-revision-one',
    });
    await ensurePublishedRevision(connector.id, 2);

    await expect(
      repository.updateBindingCas(connector.id, 0, {
        expiresAt: null,
        oauthTokenRef: null,
        publishedRevision: 2,
        revokedAt: null,
        scopes: [],
        status: 'pending',
        tokenFingerprint: null,
      }),
    ).resolves.toMatchObject({ publishedRevision: 2, revision: 1, status: 'pending' });
    await expect(catalog.reserveOAuthState('b'.repeat(64))).resolves.toMatchObject({
      status: 'reserved',
      state: { publishedRevision: 1 },
    });
    await expect(
      repository.createOAuthState({
        bindingId: binding.id,
        connectorId: connector.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        id: 'm09-state-revision-two',
        pkceVerifierRef: 'vault://oauth/revision-two/pkce',
        publishedRevision: 2,
        redirectUri: 'https://aihub.example.test/oauth/callback',
        stateHash: 'c'.repeat(64),
        stateId: 'm09-state-revision-two',
      }),
    ).resolves.toMatchObject({ publishedRevision: 2 });

    const historical = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.id, 'm09-state-revision-one'));
    expect(historical[0]).toMatchObject({
      consumedAt: expect.any(Date),
      publishedRevision: 1,
      revokedAt: null,
    });
  });

  it('linearizes consume and revoke without leaving a replayable state', async () => {
    const connector = await createConnector('oauth-consume-revoke', 'per_user_oauth');
    const binding = await createBinding(userIds[0], connector.id, 'm09-binding-consume-revoke');
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    const stateHash = 'd'.repeat(64);
    await repository.createOAuthState({
      bindingId: binding.id,
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      id: 'm09-state-consume-revoke',
      pkceVerifierRef: 'vault://oauth/consume-revoke/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      stateHash,
      stateId: 'm09-consume-revoke',
    });

    const [reserved] = await Promise.all([
      catalog.reserveOAuthState(stateHash),
      repository.revokeBindingWithPreviousSecret(connector.id),
    ]);
    const [state] = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.id, 'm09-state-consume-revoke'));
    expect(state).toMatchObject({ consumedAt: null, revokedAt: expect.any(Date) });
    expect(
      reserved.status !== 'reserved' ||
        (reserved.status === 'reserved' && reserved.state.id === state.id),
    ).toBe(true);
    await expect(catalog.reserveOAuthState(stateHash)).resolves.toMatchObject({
      status: 'invalid',
    });
    await expect(repository.getBinding(connector.id)).resolves.toMatchObject({ status: 'revoked' });
  });

  it('covers both create/revoke lock orderings without an outstanding post-revoke state', async () => {
    const firstConnector = await createConnector('oauth-create-first', 'per_user_oauth');
    const firstBinding = await createBinding(
      userIds[0],
      firstConnector.id,
      'm09-binding-create-first',
    );
    const firstRepository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    await firstRepository.createOAuthState({
      bindingId: firstBinding.id,
      connectorId: firstConnector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      id: 'm09-state-create-first',
      pkceVerifierRef: 'vault://oauth/create-first/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      stateHash: 'e'.repeat(64),
      stateId: 'm09-create-first',
    });
    await firstRepository.revokeBindingWithPreviousSecret(firstConnector.id);

    const secondConnector = await createConnector('oauth-revoke-first', 'per_user_oauth');
    const secondBinding = await createBinding(
      userIds[1],
      secondConnector.id,
      'm09-binding-revoke-first',
    );
    const secondRepository = new PlatformUserConnectorBindingRepository(serverDB, userIds[1]);
    await secondRepository.revokeBindingWithPreviousSecret(secondConnector.id);
    await expect(
      secondRepository.createOAuthState({
        bindingId: secondBinding.id,
        connectorId: secondConnector.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        id: 'm09-state-revoke-first',
        pkceVerifierRef: 'vault://oauth/revoke-first/pkce',
        publishedRevision: 1,
        redirectUri: 'https://aihub.example.test/oauth/callback',
        stateHash: 'f'.repeat(64),
        stateId: 'm09-revoke-first',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');

    const states = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(inArray(platformConnectorOAuthStates.bindingId, [firstBinding.id, secondBinding.id]));
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ consumedAt: null, revokedAt: expect.any(Date) });
  });

  it('revokes all bindings in bounded idempotent pages and clears token metadata', async () => {
    const connector = await createConnector('revoke-all', 'per_user_oauth');
    for (const [index, userId] of userIds.entries()) {
      const binding = await createBinding(userId, connector.id, `m09-binding-${index}`);
      await new PlatformUserConnectorBindingRepository(serverDB, userId).createOAuthState({
        bindingId: binding.id,
        connectorId: connector.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        id: `m09-revoke-all-state-${index}`,
        pkceVerifierRef: `vault://oauth/revoke-all/${index}`,
        publishedRevision: 1,
        redirectUri: 'https://aihub.example.test/oauth/callback',
        stateHash: String(index + 6).repeat(64),
        stateId: `m09-revoke-all-${index}`,
      });
    }
    const first = await catalog.revokeAllBindingsPage({
      connectorId: connector.id,
      limit: 2,
    });
    expect(first).toEqual({
      nextCursor: 'm09-binding-1',
      pkceVerifierRefs: ['vault://oauth/revoke-all/0', 'vault://oauth/revoke-all/1'],
      revoked: 2,
      tokenRefs: userIds
        .slice(0, 2)
        .map((userId) => `vault://users/${userId}/connectors/${connector.id}/token`),
    });
    const second = await catalog.revokeAllBindingsPage({
      afterId: first.nextCursor!,
      connectorId: connector.id,
      limit: 2,
    });
    expect(second).toEqual({
      nextCursor: null,
      pkceVerifierRefs: ['vault://oauth/revoke-all/2', 'vault://oauth/revoke-all/3'],
      revoked: 2,
      tokenRefs: userIds
        .slice(2)
        .map((userId) => `vault://users/${userId}/connectors/${connector.id}/token`),
    });
    await expect(
      catalog.revokeAllBindingsPage({ connectorId: connector.id, limit: 100 }),
    ).resolves.toEqual({ nextCursor: null, pkceVerifierRefs: [], revoked: 0, tokenRefs: [] });

    const rows = await serverDB
      .select()
      .from(platformUserConnectorBindings)
      .where(eq(platformUserConnectorBindings.connectorId, connector.id));
    expect(rows).toHaveLength(4);
    expect(
      rows.every(
        (row) =>
          row.expiresAt === null &&
          row.oauthTokenRef === null &&
          row.scopes.length === 0 &&
          row.tokenFingerprint === null,
      ),
    ).toBe(true);
    expect(rows.every((row) => row.status === 'revoked' && row.revision === 1)).toBe(true);
    const states = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.connectorId, connector.id));
    expect(states).toHaveLength(4);
    expect(
      states.every((state) => state.consumedAt === null && state.revokedAt instanceof Date),
    ).toBe(true);
  });
});

describe('PlatformUserConnectorBindingRepository', () => {
  it('never finalizes after a reserved state is disconnected', async () => {
    const connector = await createPublishedOAuthConnector('oauth-reserve-disconnect');
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    const stateHash = 'b'.repeat(64);
    await repository.prepareOAuthAuthorization({
      bindingId: 'm09-oauth-reserve-disconnect-binding',
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      pkceVerifierRef: 'vault://oauth/reserve-disconnect/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      scopes: ['read'],
      stateHash,
      stateId: 'b'.repeat(32),
    });
    const reservation = await catalog.reserveOAuthState(stateHash);
    if (reservation.status !== 'reserved') throw new Error('state was not reserved');
    const revoked = await repository.revokeBindingWithPreviousSecret(connector.id);
    expect(revoked?.pkceVerifierRefs).toEqual(['vault://oauth/reserve-disconnect/pkce']);

    await expect(
      repository.finalizeOAuthAuthorization({
        connectedAt: new Date(),
        connectorId: connector.id,
        expiresAt: null,
        expectedBindingRevision: reservation.bindingRevision,
        oauthTokenRef: 'vault://oauth/reserve-disconnect/token',
        publishedRevision: 1,
        reservedAt: reservation.reservedAt,
        scopes: ['read'],
        stateHash,
        tokenFingerprint: 'sha256:reserve-disconnect',
      }),
    ).rejects.toThrow();
    await expect(repository.getBinding(connector.id)).resolves.toMatchObject({
      oauthTokenRef: null,
      status: 'revoked',
    });
    const [state] = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.stateHash, stateHash));
    expect(state).toMatchObject({ consumedAt: null, revokedAt: expect.any(Date) });
  });

  it('never finalizes after admin revokeAll and keeps the shared lock order terminating', async () => {
    const connector = await createPublishedOAuthConnector('oauth-reserve-admin-revoke');
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[1]);
    const stateHash = 'c'.repeat(64);
    await repository.prepareOAuthAuthorization({
      bindingId: 'm09-oauth-reserve-admin-binding',
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      pkceVerifierRef: 'vault://oauth/reserve-admin/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      scopes: ['read'],
      stateHash,
      stateId: 'c'.repeat(32),
    });
    const reservation = await catalog.reserveOAuthState(stateHash);
    if (reservation.status !== 'reserved') throw new Error('state was not reserved');
    const revoked = await catalog.revokeAllBindingsPage({ connectorId: connector.id, limit: 100 });
    expect(revoked).toMatchObject({
      pkceVerifierRefs: ['vault://oauth/reserve-admin/pkce'],
      revoked: 1,
    });

    const finalize = repository.finalizeOAuthAuthorization({
      connectedAt: new Date(),
      connectorId: connector.id,
      expiresAt: null,
      expectedBindingRevision: reservation.bindingRevision,
      oauthTokenRef: 'vault://oauth/reserve-admin/token',
      publishedRevision: 1,
      reservedAt: reservation.reservedAt,
      scopes: ['read'],
      stateHash,
      tokenFingerprint: 'sha256:reserve-admin',
    });
    await expect(
      Promise.race([
        finalize.then(
          () => 'finalized',
          () => 'rejected',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('deadlock'), 2000)),
      ]),
    ).resolves.toBe('rejected');
    await expect(repository.getBinding(connector.id)).resolves.toMatchObject({ status: 'revoked' });
  });

  it('prepares, reserves, releases, finalizes, and revokes one owner-scoped OAuth binding', async () => {
    const connector = await createConnector('oauth-lifecycle', 'per_user_oauth');
    await ensurePublishedRevision(connector.id);
    await catalog.setPublishedPointerCas({
      checksum: '1'.padStart(64, '0'),
      connectorId: connector.id,
      expectedRevision: 0,
      publishedAt: new Date(),
      publishedRevision: 1,
    });
    await serverDB
      .update(platformConnectors)
      .set({ enabled: true })
      .where(eq(platformConnectors.id, connector.id));
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    const stateHash = '9'.repeat(64);
    const prepared = await repository.prepareOAuthAuthorization({
      bindingId: 'm09-oauth-lifecycle-binding',
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      pkceVerifierRef: 'vault://oauth/lifecycle/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      scopes: ['read'],
      stateHash,
      stateId: '9'.repeat(32),
    });
    const binding = prepared.binding;
    expect(binding).toMatchObject({ status: 'pending', userId: userIds[0] });
    await expect(
      new PlatformUserConnectorBindingRepository(serverDB, userIds[1]).getBinding(connector.id),
    ).resolves.toBeUndefined();

    const reservations = await Promise.all([
      catalog.reserveOAuthState(stateHash),
      catalog.reserveOAuthState(stateHash),
    ]);
    const winner = reservations.find((result) => result.status === 'reserved');
    expect(reservations.filter((result) => result.status === 'reserved')).toHaveLength(1);
    expect(reservations.filter((result) => result.status === 'replayed')).toHaveLength(1);
    if (!winner || winner.status !== 'reserved') throw new Error('missing reservation winner');
    await expect(catalog.releaseOAuthStateReservation(stateHash, winner.reservedAt)).resolves.toBe(
      true,
    );
    const retried = await catalog.reserveOAuthState(stateHash);
    if (retried.status !== 'reserved') throw new Error('state was not retryable after release');
    const finalized = await repository.finalizeOAuthAuthorization({
      connectedAt: new Date(),
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 60_000),
      oauthTokenRef: 'vault://oauth/lifecycle/token-v1',
      publishedRevision: 1,
      expectedBindingRevision: retried.bindingRevision,
      reservedAt: retried.reservedAt,
      scopes: ['read'],
      stateHash,
      tokenFingerprint: 'sha256:token-v1',
    });
    expect(finalized).toMatchObject({
      binding: { status: 'connected', userId: userIds[0] },
      previousTokenRef: null,
    });

    await ensurePublishedRevision(connector.id, 2);
    await catalog.setPublishedPointerCas({
      checksum: '2'.padStart(64, '0'),
      connectorId: connector.id,
      expectedRevision: 1,
      publishedAt: new Date(),
      publishedRevision: 2,
    });
    const reauthorization = await repository.prepareOAuthAuthorization({
      bindingId: 'ignored-new-binding-id',
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      pkceVerifierRef: 'vault://oauth/lifecycle/pkce-v2',
      publishedRevision: 2,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      scopes: ['read'],
      stateHash: '8'.repeat(64),
      stateId: '8'.repeat(32),
    });
    expect(reauthorization.binding).toMatchObject({
      id: binding.id,
      oauthTokenRef: 'vault://oauth/lifecycle/token-v1',
      publishedRevision: 1,
      status: 'connected',
    });
    const [reauthorizationState] = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.stateHash, '8'.repeat(64)));
    expect(reauthorizationState.publishedRevision).toBe(2);

    const revisionTwoReservation = await catalog.reserveOAuthState('8'.repeat(64));
    if (revisionTwoReservation.status !== 'reserved') {
      throw new Error('revision two state was not reservable');
    }
    await expect(
      repository.finalizeOAuthAuthorization({
        connectedAt: new Date(),
        connectorId: connector.id,
        expiresAt: new Date(Date.now() + 60_000),
        expectedBindingRevision: revisionTwoReservation.bindingRevision,
        oauthTokenRef: 'vault://oauth/lifecycle/token-v2',
        publishedRevision: 2,
        reservedAt: revisionTwoReservation.reservedAt,
        scopes: ['read'],
        stateHash: '8'.repeat(64),
        tokenFingerprint: 'sha256:token-v2',
      }),
    ).resolves.toMatchObject({
      binding: { oauthTokenRef: 'vault://oauth/lifecycle/token-v2', publishedRevision: 2 },
      previousTokenRef: 'vault://oauth/lifecycle/token-v1',
    });

    await expect(repository.revokeBindingWithPreviousSecret(connector.id)).resolves.toMatchObject({
      binding: { oauthTokenRef: null, status: 'revoked' },
      previousTokenRef: 'vault://oauth/lifecycle/token-v2',
    });
    await expect(repository.revokeBindingWithPreviousSecret(connector.id)).resolves.toBeUndefined();
  });

  it('isolates bindings and OAuth state creation by user ownership', async () => {
    const connector = await createConnector('isolation', 'per_user_oauth');
    const bindingA = await createBinding(userIds[0], connector.id, 'm09-binding-user-a');
    const bindingB = await createBinding(userIds[1], connector.id, 'm09-binding-user-b');
    const repositoryA = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    const repositoryB = new PlatformUserConnectorBindingRepository(serverDB, userIds[1]);

    await expect(repositoryA.getBinding(connector.id)).resolves.toMatchObject({ id: bindingA.id });
    await expect(repositoryB.getBinding(connector.id)).resolves.toMatchObject({ id: bindingB.id });
    await expect(
      repositoryA.createOAuthState({
        bindingId: bindingB.id,
        connectorId: connector.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        pkceVerifierRef: 'kms://oauth/pkce',
        publishedRevision: 1,
        redirectUri: 'https://aihub.example.test/oauth/callback',
        stateHash: 'd'.repeat(64),
        stateId: 'm09-cross-user-state',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');

    await repositoryA.createOAuthState({
      bindingId: bindingA.id,
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      id: 'm09-isolation-owned-state',
      pkceVerifierRef: 'vault://oauth/isolation/pkce',
      publishedRevision: 1,
      redirectUri: 'https://aihub.example.test/oauth/callback',
      stateHash: 'a'.repeat(64),
      stateId: 'm09-isolation-owned',
    });

    await expect(repositoryA.revokeBindingWithPreviousSecret(connector.id)).resolves.toMatchObject({
      binding: {
        oauthTokenRef: null,
        status: 'revoked',
        tokenFingerprint: null,
      },
    });
    await expect(repositoryB.getBinding(connector.id)).resolves.toMatchObject({
      id: bindingB.id,
      status: 'connected',
    });
    const [state] = await serverDB
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.id, 'm09-isolation-owned-state'));
    expect(state).toMatchObject({ consumedAt: null, revokedAt: expect.any(Date) });
  });

  it('fails closed when direct attach entry points receive unknown managed secret handles', async () => {
    const connector = await createPublishedOAuthConnector('managed-attach-proof');
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);
    const missingTokenRef = `kms://platform-connectors/${connector.id}/oauthBindingToken/missing`;
    const missingPkceRef = `kms://platform-connectors/${connector.id}/oauthPkceVerifier/missing`;

    await expect(
      repository.upsertBinding({
        connectedAt: new Date(),
        connectorId: connector.id,
        id: 'm09-managed-attach-binding',
        oauthTokenRef: missingTokenRef,
        publishedRevision: 1,
        scopes: ['read'],
        status: 'connected',
        tokenFingerprint: 'sha256:missing',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');

    const binding = await repository.upsertBinding({
      connectorId: connector.id,
      id: 'm09-managed-attach-binding',
      publishedRevision: 1,
      status: 'pending',
    });
    await expect(
      repository.updateBindingCas(connector.id, binding.revision, {
        connectedAt: new Date(),
        oauthTokenRef: missingTokenRef,
        scopes: ['read'],
        status: 'connected',
        tokenFingerprint: 'sha256:missing',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    await expect(
      repository.createOAuthState({
        bindingId: binding.id,
        connectorId: connector.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        pkceVerifierRef: missingPkceRef,
        publishedRevision: 1,
        redirectUri: 'https://aihub.example.test/oauth/callback',
        stateHash: 'c'.repeat(64),
        stateId: 'm09-managed-attach-state',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    await expect(
      repository.prepareOAuthAuthorization({
        bindingId: binding.id,
        connectorId: connector.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        pkceVerifierRef: missingPkceRef,
        publishedRevision: 1,
        redirectUri: 'https://aihub.example.test/oauth/callback',
        scopes: ['read'],
        stateHash: 'b'.repeat(64),
        stateId: 'm09-managed-prepare-state',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  });

  it('applies binding CAS and keeps list pagination bounded and user-scoped', async () => {
    const connectors = await Promise.all([
      createConnector('binding-1', 'per_user_oauth'),
      createConnector('binding-2', 'per_user_oauth'),
    ]);
    await createBinding(userIds[0], connectors[0].id, 'm09-binding-list-1');
    await createBinding(userIds[0], connectors[1].id, 'm09-binding-list-2');
    await createBinding(userIds[1], connectors[0].id, 'm09-binding-list-other');
    const repository = new PlatformUserConnectorBindingRepository(serverDB, userIds[0]);

    const updated = await repository.updateBindingCas(connectors[0].id, 0, {
      scopes: ['read', 'write'],
    });
    expect(updated?.revision).toBe(1);
    await expect(
      repository.updateBindingCas(connectors[0].id, 0, { scopes: ['stale'] }),
    ).resolves.toBeUndefined();
    const first = await repository.listBindings({ limit: 1 });
    expect(first.items).toHaveLength(1);
    const second = await repository.listBindings({ cursor: first.nextCursor!, limit: 1000 });
    expect(second.items).toHaveLength(1);
    expect([...first.items, ...second.items].every((item) => item.userId === userIds[0])).toBe(
      true,
    );
  });
});
