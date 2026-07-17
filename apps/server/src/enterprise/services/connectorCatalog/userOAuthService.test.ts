// @vitest-environment node
import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAuditLogs,
  platformConnectorOAuthStates,
  platformConnectors,
  platformConnectorSecrets,
  platformResourceRevisions,
  platformUserConnectorBindings,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';

import { type KeyProvider, PlatformSecretService } from '../../security/secret';
import {
  cleanupM09ServiceData,
  connectorToolFixture,
  MemoryConnectorSecretStore,
} from './catalogTestUtils';
import type {
  ConnectorOutboundClient,
  ConnectorOutboundJsonResponse,
} from './connectorOutboundClient';
import { ConnectorCatalogDraftService } from './draftService';
import type { ConnectorOAuthOutboundAdapter } from './oauthOutboundAdapter';
import type { ConnectorOAuthRuntimeDependencies } from './oauthRuntime';
import { MANAGED_CONNECTOR_OAUTH_STATE_PREFIX } from './oauthRuntime';
import { PlatformConnectorSecretStore } from './platformConnectorSecretStore';
import { ConnectorCatalogPublicationService } from './publicationService';
import { ConnectorOAuthCallbackService, UserConnectorOAuthService } from './userOAuthService';

const db: LobeChatDatabase = await getTestDB();
const callbackRedirectUri = 'https://aihub.example.test/oauth/connector/callback';
const userA = 'm09-service-user-oauth-a';
const userB = 'm09-service-user-oauth-b';

beforeEach(async () => {
  await cleanupM09ServiceData(db);
  await db
    .insert(users)
    .values([{ id: userA }, { id: userB }])
    .onConflictDoNothing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupM09ServiceData(db);
});

const createHarness = () => {
  const secrets = new MemoryConnectorSecretStore(db);
  const catalogOutbound = {
    getPolicyVersion: () => 1,
    preflight: vi.fn(async () => ({ policyVersion: 1 })),
  } as unknown as ConnectorOutboundClient;
  const preflightAuthorization = vi.fn(async () => {});
  const preflightToken = vi.fn(async () => {});
  const exchangeCode = vi.fn(
    async (_request: {
      clientId: string;
      clientSecret?: string;
      code: string;
      codeVerifier: string;
      redirectUri: string;
      tokenEndpoint: string;
    }): Promise<ConnectorOutboundJsonResponse> => ({
      body: {
        access_token: 'provider-access-token-v1',
        expires_in: 3600,
        refresh_token: 'provider-refresh-token-v1',
        scope: 'issues:read',
        token_type: 'Bearer',
      },
      status: 200,
      url: 'https://identity.example.test/oauth/token',
    }),
  );
  const refresh = vi.fn(
    async (_request: {
      clientId: string;
      clientSecret?: string;
      refreshToken: string;
      tokenEndpoint: string;
    }): Promise<ConnectorOutboundJsonResponse> => ({
      body: {
        access_token: 'provider-access-token-v2',
        expires_in: 7200,
        refresh_token: 'provider-refresh-token-v2',
        scope: 'issues:read',
        token_type: 'Bearer',
      },
      status: 200,
      url: 'https://identity.example.test/oauth/token',
    }),
  );
  const outbound = {
    exchangeCode,
    preflightAuthorization,
    preflightToken,
    refresh,
  } as unknown as ConnectorOAuthOutboundAdapter;
  const dependencies: ConnectorOAuthRuntimeDependencies = {
    callbackRedirectUri,
    outbound,
    secrets,
  };
  return {
    callback: new ConnectorOAuthCallbackService(db, dependencies),
    dependencies,
    drafts: new ConnectorCatalogDraftService(db, secrets, callbackRedirectUri),
    exchangeCode,
    preflightAuthorization,
    preflightToken,
    publication: new ConnectorCatalogPublicationService(db, catalogOutbound, secrets, {}),
    refresh,
    secrets,
    userA: new UserConnectorOAuthService(db, userA, dependencies),
    userB: new UserConnectorOAuthService(db, userB, dependencies),
  };
};

const publishOAuthConnector = async (harness: ReturnType<typeof createHarness>) => {
  const draft = await harness.drafts.createDraft('admin-user', {
    credentialMode: 'per_user_oauth',
    displayName: 'Managed Issues',
    enabled: true,
    endpoint: 'https://connector.example.test/mcp',
    key: 'managed-issues',
    oauthClientSecret: { operation: 'replace', value: 'provider-client-secret' },
    oauthConfig: {
      authorizationEndpoint: 'https://identity.example.test/oauth/authorize',
      clientId: 'managed-client-id',
      issuer: 'https://identity.example.test',
      scopes: ['issues:read'],
      tokenEndpoint: 'https://identity.example.test/oauth/token',
    },
    reason: 'create OAuth connector',
    tools: [connectorToolFixture()],
    transport: 'http',
  });
  await harness.publication.publish('admin-user', {
    expectedDraftToken: draft.draftToken,
    expectedRevision: 0,
    id: draft.draft.id,
    reason: 'publish OAuth connector',
  });
  return harness.drafts.getDraft(draft.draft.id);
};

const start = async (
  harness: ReturnType<typeof createHarness>,
  connectorId: string,
  returnTo = '/settings/connectors',
) => {
  const result = await harness.userA.startAuthorization({ connectorId, returnTo });
  const url = new URL(result.authorizationUrl);
  return {
    challenge: url.searchParams.get('code_challenge')!,
    result,
    state: url.searchParams.get('state')!,
    url,
  };
};

describe('per-user connector OAuth service', () => {
  it('keeps token and PKCE handles live when they attach after GC candidate selection', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: new Uint8Array(32).fill(5), keyId: 'gc:test' }),
      providerId: 'test',
    };
    const baseStore = new PlatformConnectorSecretStore(
      db,
      new PlatformSecretService({ keyProvider }),
    );
    const runBarrierGc = async (attach: () => Promise<void>) => {
      let candidatesSelected!: () => void;
      let release!: () => void;
      const selected = new Promise<void>((resolve) => {
        candidatesSelected = resolve;
      });
      const waitForRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gcStore = new PlatformConnectorSecretStore(
        db,
        new PlatformSecretService({ keyProvider }),
        {
          beforeGcAtomicRevoke: async () => {
            candidatesSelected();
            await waitForRelease;
          },
        },
      );
      const gc = gcStore.garbageCollectOrphanedOAuthSecrets();
      await selected;
      await attach();
      release();
      return gc;
    };

    const token = await baseStore.persistSecret({
      connectorId: published.draft.id,
      slot: 'oauthBindingToken',
      value: { accessToken: 'barrier-token' },
    });
    await db
      .update(platformConnectorSecrets)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(platformConnectorSecrets.ref, token.ref));
    const bindingId = 'm09-gc-barrier-binding';
    await expect(
      runBarrierGc(async () => {
        await db.insert(platformUserConnectorBindings).values({
          connectedAt: new Date(),
          connectorId: published.draft.id,
          id: bindingId,
          oauthTokenRef: token.ref,
          publishedRevision: 1,
          scopes: ['issues:read'],
          status: 'connected',
          tokenFingerprint: token.fingerprint,
          userId: userA,
        });
      }),
    ).resolves.toBe(0);
    await expect(
      baseStore.resolveSecretRef({
        connectorId: published.draft.id,
        ref: token.ref,
        slot: 'oauthBindingToken',
      }),
    ).resolves.not.toBeNull();

    const pkce = await baseStore.persistSecret({
      connectorId: published.draft.id,
      slot: 'oauthPkceVerifier',
      value: 'v'.repeat(64),
    });
    await db
      .update(platformConnectorSecrets)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(platformConnectorSecrets.ref, pkce.ref));
    await expect(
      runBarrierGc(async () => {
        await db.insert(platformConnectorOAuthStates).values({
          bindingId,
          connectorId: published.draft.id,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          id: 'm09-gc-barrier-state',
          pkceVerifierRef: pkce.ref,
          publishedRevision: 1,
          redirectUri: callbackRedirectUri,
          stateHash: '7'.repeat(64),
          stateId: 'm09-gc-barrier-state',
          userId: userA,
        });
      }),
    ).resolves.toBe(0);
    await expect(
      baseStore.resolveSecretRef({
        connectorId: published.draft.id,
        ref: pkce.ref,
        slot: 'oauthPkceVerifier',
      }),
    ).resolves.not.toBeNull();
  });

  it('cleans replaced and explicitly abandoned PKCE handles after detaching DB references', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const first = await start(harness, published.draft.id);
    const [firstState] = await db.select().from(platformConnectorOAuthStates);
    const second = await start(harness, published.draft.id);
    await expect(
      harness.secrets.resolveSecretRef({
        connectorId: published.draft.id,
        ref: firstState.pkceVerifierRef,
        slot: 'oauthPkceVerifier',
      }),
    ).resolves.toBeNull();
    const [secondState] = await db
      .select()
      .from(platformConnectorOAuthStates)
      .where(
        eq(
          platformConnectorOAuthStates.stateHash,
          createHash('sha256').update(second.state).digest('hex'),
        ),
      );
    await harness.callback.abandonAuthorization(second.state);
    await expect(
      harness.secrets.resolveSecretRef({
        connectorId: published.draft.id,
        ref: secondState.pkceVerifierRef,
        slot: 'oauthPkceVerifier',
      }),
    ).resolves.toBeNull();
    await expect(
      harness.callback.callback({ code: 'must-not-run', state: second.state }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_OAUTH_STATE_INVALID' });
    expect(first.state).not.toBe(second.state);
  });

  it('lists only safe projections and binds authorization state exclusively to user A', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const authorization = await start(harness, published.draft.id);

    expect(authorization.url.origin).toBe('https://identity.example.test');
    expect(authorization.url.searchParams.get('redirect_uri')).toBe(callbackRedirectUri);
    expect(authorization.url.searchParams.get('scope')).toBe('issues:read');
    expect(authorization.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.state.startsWith(MANAGED_CONNECTOR_OAUTH_STATE_PREFIX)).toBe(true);
    expect(authorization.state.slice(MANAGED_CONNECTOR_OAUTH_STATE_PREFIX.length)).toHaveLength(43);
    expect(harness.preflightAuthorization).toHaveBeenCalledWith(
      'https://identity.example.test/oauth/authorize',
    );

    const [state] = await db.select().from(platformConnectorOAuthStates);
    expect(state).toMatchObject({
      connectorId: published.draft.id,
      publishedRevision: 1,
      redirectUri: callbackRedirectUri,
      returnTo: '/settings/connectors',
      scopes: ['issues:read'],
      userId: userA,
    });
    expect(state.stateHash).toBe(createHash('sha256').update(authorization.state).digest('hex'));
    const databaseJson = JSON.stringify(await db.select().from(platformConnectorOAuthStates));
    expect(databaseJson).not.toContain(authorization.state);
    expect(databaseJson).not.toContain('provider-client-secret');

    const [listA, listB, statusA, statusB] = await Promise.all([
      harness.userA.listManaged({ limit: 50 }),
      harness.userB.listManaged({ limit: 50 }),
      harness.userA.getAuthorizationStatus({
        attemptId: authorization.result.attemptId,
        connectorId: published.draft.id,
      }),
      harness.userB.getAuthorizationStatus({
        attemptId: authorization.result.attemptId,
        connectorId: published.draft.id,
      }),
    ]);
    expect(listA.items[0]?.binding).toMatchObject({ id: authorization.result.bindingId });
    expect(listB.items[0]?.binding).toBeNull();
    expect(statusA).toEqual({
      attemptId: authorization.result.attemptId,
      binding: null,
      status: 'pending',
    });
    expect(statusB).toEqual({
      attemptId: authorization.result.attemptId,
      binding: null,
      status: 'invalid',
    });
    for (const projection of [listA, listB, statusA, statusB]) {
      expect(JSON.stringify(projection)).not.toMatch(
        /endpoint|clientId|oauthConfig|tokenFingerprint|oauthTokenRef|vault:\/\//i,
      );
    }
  });

  it('uses PKCE, stores only immutable token refs, and permits one callback winner', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const authorization = await start(harness, published.draft.id);
    const callbacks = await Promise.allSettled([
      harness.callback.callback({ code: 'authorization-code', state: authorization.state }),
      harness.callback.callback({ code: 'authorization-code', state: authorization.state }),
    ]);
    expect(callbacks.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(callbacks.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const exchange = harness.exchangeCode.mock.calls[0]![0];
    expect(exchange).toBeDefined();
    expect(createHash('sha256').update(exchange.codeVerifier).digest('base64url')).toBe(
      authorization.challenge,
    );
    expect(exchange).toMatchObject({
      clientId: 'managed-client-id',
      clientSecret: 'provider-client-secret',
      redirectUri: callbackRedirectUri,
    });

    const [binding] = await db.select().from(platformUserConnectorBindings);
    expect(binding).toMatchObject({
      publishedRevision: 1,
      scopes: ['issues:read'],
      status: 'connected',
      userId: userA,
    });
    expect(binding.oauthTokenRef).toMatch(/^vault:\/\//);
    const [completedState] = await db
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.stateId, authorization.result.attemptId));
    expect(completedState).toMatchObject({
      authorizationOutcome: 'completed',
      finishedAt: expect.any(Date),
    });
    const persistedJson = JSON.stringify({
      audits: await db.select().from(platformAuditLogs),
      bindings: await db.select().from(platformUserConnectorBindings),
      revisions: await db.select().from(platformResourceRevisions),
      states: await db.select().from(platformConnectorOAuthStates),
    });
    expect(persistedJson).not.toContain('provider-access-token-v1');
    expect(persistedJson).not.toContain('provider-refresh-token-v1');
    expect(persistedJson).not.toContain('provider-client-secret');
    await expect(
      harness.callback.callback({ code: 'replayed', state: authorization.state }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_OAUTH_STATE_REPLAYED' });
    await expect(
      harness.callback.callback({ code: 'tampered', state: `${authorization.state}x` }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_OAUTH_STATE_INVALID' });
  });

  it('keeps a reserved callback pending until its exact attempt commits', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const authorization = await start(harness, published.draft.id);
    let releaseExchange!: () => void;
    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    harness.exchangeCode.mockImplementationOnce(async () => {
      exchangeStarted();
      await release;
      return {
        body: {
          access_token: 'provider-access-token-reserved',
          refresh_token: 'provider-refresh-token-reserved',
          scope: 'issues:read',
          token_type: 'Bearer',
        },
        status: 200,
        url: 'https://identity.example.test/oauth/token',
      };
    });
    const callback = harness.callback.callback({ code: 'in-flight', state: authorization.state });
    await started;
    await expect(
      harness.userA.getAuthorizationStatus({
        attemptId: authorization.result.attemptId,
        connectorId: published.draft.id,
      }),
    ).resolves.toEqual({
      attemptId: authorization.result.attemptId,
      binding: null,
      status: 'pending',
    });
    releaseExchange();
    await expect(callback).resolves.toEqual({ returnTo: '/settings/connectors' });
    await expect(
      harness.userA.getAuthorizationStatus({
        attemptId: authorization.result.attemptId,
        connectorId: published.draft.id,
      }),
    ).resolves.toMatchObject({ binding: { status: 'connected' }, status: 'completed' });
  });

  it('expires an unconsumed attempt without exposing a preserved binding', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const first = await start(harness, published.draft.id);
    await harness.callback.callback({ code: 'connected', state: first.state });
    const attempt = await start(harness, published.draft.id);
    const [state] = await db
      .select()
      .from(platformConnectorOAuthStates)
      .where(eq(platformConnectorOAuthStates.stateId, attempt.result.attemptId));
    harness.dependencies.clock = () => new Date(state!.expiresAt.getTime() + 1);
    await expect(
      harness.userA.getAuthorizationStatus({
        attemptId: attempt.result.attemptId,
        connectorId: published.draft.id,
      }),
    ).resolves.toEqual({
      attemptId: attempt.result.attemptId,
      binding: null,
      status: 'expired',
    });
  });

  it('keeps exchange-attempted state single-use and preserves a valid binding during reconnect', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const first = await start(harness, published.draft.id);
    await harness.callback.callback({ code: 'first', state: first.state });
    const [connected] = await db.select().from(platformUserConnectorBindings);
    const originalRef = connected.oauthTokenRef;
    await expect(
      harness.userA.getAuthorizationStatus({
        attemptId: first.result.attemptId,
        connectorId: published.draft.id,
      }),
    ).resolves.toMatchObject({ binding: { status: 'connected' }, status: 'completed' });

    const reconnect = await start(harness, published.draft.id);
    await expect(
      harness.userA.getAuthorizationStatus({
        attemptId: reconnect.result.attemptId,
        connectorId: published.draft.id,
      }),
    ).resolves.toEqual({
      attemptId: reconnect.result.attemptId,
      binding: null,
      status: 'pending',
    });
    await expect(
      harness.userA.getAuthorizationStatus({
        attemptId: first.result.attemptId,
        connectorId: published.draft.id,
      }),
    ).resolves.toMatchObject({ binding: null, status: 'superseded' });
    harness.exchangeCode.mockRejectedValueOnce(new Error('provider private failure'));
    await expect(
      harness.callback.callback({ code: 'retryable', state: reconnect.state }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID' });
    await expect(
      harness.userA.getAuthorizationStatus({
        attemptId: reconnect.result.attemptId,
        connectorId: published.draft.id,
      }),
    ).resolves.toEqual({
      attemptId: reconnect.result.attemptId,
      binding: null,
      status: 'failed',
    });
    expect((await db.select().from(platformUserConnectorBindings))[0]?.oauthTokenRef).toBe(
      originalRef,
    );
    await expect(
      harness.callback.callback({ code: 'must-not-reuse', state: reconnect.state }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_OAUTH_STATE_REPLAYED' });
    const restarted = await start(harness, published.draft.id);
    await expect(
      harness.userA.getAuthorizationStatus({
        attemptId: reconnect.result.attemptId,
        connectorId: published.draft.id,
      }),
    ).resolves.toMatchObject({ binding: null, status: 'superseded' });
    harness.exchangeCode.mockResolvedValueOnce({
      body: {
        access_token: 'provider-access-token-reconnected',
        refresh_token: 'provider-refresh-token-reconnected',
        scope: 'issues:read',
        token_type: 'Bearer',
      },
      status: 200,
      url: 'https://identity.example.test/oauth/token',
    });
    await expect(
      harness.callback.callback({ code: 'new-authorization-code', state: restarted.state }),
    ).resolves.toEqual({ returnTo: '/settings/connectors' });
    await expect(
      harness.userA.getAuthorizationStatus({
        attemptId: restarted.result.attemptId,
        connectorId: published.draft.id,
      }),
    ).resolves.toMatchObject({ binding: { status: 'connected' }, status: 'completed' });
    expect((await db.select().from(platformUserConnectorBindings))[0]?.oauthTokenRef).not.toBe(
      originalRef,
    );
  });

  it('rejects scope escalation and malformed or oversized token responses without consuming state', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const invalidResponses = [
      { access_token: 'token', scope: 'issues:write', token_type: 'Bearer' },
      { access_token: 'token', unexpected: 'provider metadata' },
      { access_token: 'x'.repeat(32_769), token_type: 'Bearer' },
    ];
    for (const body of invalidResponses) {
      const authorization = await start(harness, published.draft.id);
      harness.exchangeCode.mockResolvedValueOnce({
        body,
        status: 200,
        url: 'https://identity.example.test/oauth/token',
      });
      await expect(
        harness.callback.callback({ code: 'invalid-response', state: authorization.state }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(
          /PLATFORM_CONNECTOR_(OAUTH_CALLBACK_INVALID|SCOPE_NOT_ALLOWED)/,
        ),
      });
    }
    const valid = await start(harness, published.draft.id);
    await expect(
      harness.callback.callback({ code: 'valid-retry', state: valid.state }),
    ).resolves.toEqual({ returnTo: '/settings/connectors' });
  });

  it('rejects revision drift before token exchange', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const authorization = await start(harness, published.draft.id);
    await db
      .update(platformConnectors)
      .set({ enabled: false, status: 'archived' })
      .where(eq(platformConnectors.id, published.draft.id));

    await expect(
      harness.callback.callback({ code: 'stale-revision', state: authorization.state }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID' });
    expect(harness.exchangeCode).not.toHaveBeenCalled();
  });

  it('rejects expired states, redirect drift, and Secret Store failure without token leakage', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const expired = await start(harness, published.draft.id);
    const now = Date.now();
    await db
      .update(platformConnectorOAuthStates)
      .set({
        createdAt: new Date(now - 10 * 60 * 1000),
        expiresAt: new Date(now - 5 * 60 * 1000),
      })
      .where(
        eq(
          platformConnectorOAuthStates.stateHash,
          createHash('sha256').update(expired.state).digest('hex'),
        ),
      );
    await expect(
      harness.callback.callback({ code: 'expired', state: expired.state }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_OAUTH_STATE_EXPIRED' });
    expect(harness.exchangeCode).not.toHaveBeenCalled();

    const wrongRedirectService = new UserConnectorOAuthService(db, userA, {
      ...harness.dependencies,
      callbackRedirectUri: 'https://aihub.example.test/oauth/other-callback',
    });
    await expect(
      wrongRedirectService.startAuthorization({ connectorId: published.draft.id }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID' });

    const authorization = await start(harness, published.draft.id);
    const persist = harness.secrets.persistSecret;
    vi.spyOn(harness.secrets, 'persistSecret').mockImplementation(async (params) => {
      if (params.slot === 'oauthBindingToken') throw new Error('secret-store-private-failure');
      return persist(params);
    });
    await expect(
      harness.callback.callback({ code: 'secret-store-failure', state: authorization.state }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID' });
    await expect(
      harness.callback.callback({ code: 'must-not-reuse', state: authorization.state }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_OAUTH_STATE_REPLAYED' });
    expect(JSON.stringify(await db.select().from(platformUserConnectorBindings))).not.toContain(
      'provider-access-token-v1',
    );
  });

  it('bounds cleanup of PKCE and unbound token handles on database races', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    let pkceRef: string | undefined;
    const persist = harness.secrets.persistSecret;
    vi.spyOn(harness.secrets, 'persistSecret').mockImplementation(async (params) => {
      const stored = await persist(params);
      if (params.slot === 'oauthPkceVerifier') pkceRef = stored.ref;
      return stored;
    });
    harness.preflightAuthorization.mockImplementationOnce(async () => {
      await db
        .update(platformConnectors)
        .set({ status: 'archived' })
        .where(eq(platformConnectors.id, published.draft.id));
    });
    await expect(
      harness.userA.startAuthorization({ connectorId: published.draft.id }),
    ).rejects.toThrow();
    expect(pkceRef).toBeDefined();
    await expect(
      harness.secrets.resolveSecretRef({
        connectorId: published.draft.id,
        ref: pkceRef!,
        slot: 'oauthPkceVerifier',
      }),
    ).resolves.toBeNull();

    await db
      .update(platformConnectors)
      .set({ status: 'published' })
      .where(eq(platformConnectors.id, published.draft.id));
    const authorization = await start(harness, published.draft.id);
    let tokenRef: string | undefined;
    vi.mocked(harness.secrets.persistSecret).mockImplementation(async (params) => {
      const stored = await persist(params);
      if (params.slot === 'oauthBindingToken') {
        tokenRef = stored.ref;
        await db
          .update(platformConnectors)
          .set({ status: 'archived' })
          .where(eq(platformConnectors.id, published.draft.id));
      }
      return stored;
    });
    await expect(
      harness.callback.callback({ code: 'authorization-code', state: authorization.state }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID' });
    expect(tokenRef).toBeDefined();
    await expect(
      harness.secrets.resolveSecretRef({
        connectorId: published.draft.id,
        ref: tokenRef!,
        slot: 'oauthBindingToken',
      }),
    ).resolves.toBeNull();
    await expect(
      harness.callback.callback({ code: 'must-not-repeat', state: authorization.state }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONNECTOR_OAUTH_STATE_REPLAYED' });
  });

  it('rotates refresh tokens only after CAS and disconnects idempotently without crossing users', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const authorization = await start(harness, published.draft.id);
    await harness.callback.callback({ code: 'connect', state: authorization.state });
    const original = (await db.select().from(platformUserConnectorBindings))[0]!;

    harness.refresh.mockRejectedValueOnce(new Error('provider refresh unavailable'));
    await expect(harness.userA.refreshBinding(published.draft.id)).rejects.toThrow();
    expect((await db.select().from(platformUserConnectorBindings))[0]?.oauthTokenRef).toBe(
      original.oauthTokenRef,
    );
    await harness.userA.refreshBinding(published.draft.id);
    const refreshed = (await db.select().from(platformUserConnectorBindings))[0]!;
    expect(refreshed.oauthTokenRef).not.toBe(original.oauthTokenRef);
    expect(refreshed.status).toBe('connected');
    expect(harness.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: 'provider-refresh-token-v1' }),
    );
    await expect(
      harness.secrets.resolveSecretRef({
        connectorId: published.draft.id,
        ref: original.oauthTokenRef!,
        slot: 'oauthBindingToken',
      }),
    ).resolves.toBeNull();

    await expect(harness.userA.disconnect({ connectorId: published.draft.id })).resolves.toEqual({
      disconnected: true,
    });
    await expect(harness.userA.disconnect({ connectorId: published.draft.id })).resolves.toEqual({
      disconnected: true,
    });
    await expect(
      harness.userB.getAuthorizationStatus({
        attemptId: authorization.result.attemptId,
        connectorId: published.draft.id,
      }),
    ).resolves.toEqual({
      attemptId: authorization.result.attemptId,
      binding: null,
      status: 'invalid',
    });
    const [revoked] = await db.select().from(platformUserConnectorBindings);
    expect(revoked).toMatchObject({ oauthTokenRef: null, scopes: [], status: 'revoked' });
    const auditJson = JSON.stringify(await db.select().from(platformAuditLogs));
    expect(auditJson).not.toMatch(/provider-(access|refresh|client)-token|vault:\/\//i);
  });

  it('acquires a shared binding-revision lease before calling a rotating token provider', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const authorization = await start(harness, published.draft.id);
    await harness.callback.callback({ code: 'connect', state: authorization.state });

    let releaseRefresh!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    harness.refresh.mockImplementationOnce(async () => {
      markStarted();
      await gate;
      return {
        body: {
          access_token: 'provider-access-token-v2',
          expires_in: 7200,
          refresh_token: 'provider-refresh-token-v2',
          scope: 'issues:read',
          token_type: 'Bearer',
        },
        status: 200,
        url: 'https://identity.example.test/oauth/token',
      };
    });

    const first = harness.userA.refreshBinding(published.draft.id);
    await started;
    await expect(harness.userA.refreshBinding(published.draft.id)).rejects.toMatchObject({
      code: 'PLATFORM_CONNECTOR_RESOURCE_MISMATCH',
    });
    expect(harness.refresh).toHaveBeenCalledOnce();

    releaseRefresh();
    await expect(first).resolves.toBeUndefined();
    expect(harness.refresh).toHaveBeenCalledOnce();
  });

  it('refreshes the historical v1 binding used by an approved operation after v2 publishes', async () => {
    const harness = createHarness();
    const first = await publishOAuthConnector(harness);
    const authorization = await start(harness, first.draft.id);
    await harness.callback.callback({ code: 'connect-v1', state: authorization.state });
    const publishedV1 = await harness.drafts.getDraft(first.draft.id);
    const second = await harness.drafts.updateDraft('admin-user', {
      expectedDraftToken: publishedV1.draftToken,
      expectedRevision: 1,
      id: first.draft.id,
      oauthClientSecret: { operation: 'replace', value: 'provider-client-secret-v2' },
      oauthConfig: {
        authorizationEndpoint: 'https://identity-v2.example.test/oauth/authorize',
        clientId: 'managed-client-id-v2',
        issuer: 'https://identity-v2.example.test',
        scopes: ['issues:read'],
        tokenEndpoint: 'https://identity-v2.example.test/oauth/token',
      },
      reason: 'prepare OAuth connector v2',
    });
    await harness.publication.publish('admin-user', {
      expectedDraftToken: second.draftToken,
      expectedRevision: 2,
      id: first.draft.id,
      reason: 'publish OAuth connector v2',
    });

    await harness.userA.refreshBinding(first.draft.id, 1);

    expect(harness.preflightToken).toHaveBeenLastCalledWith(
      'https://identity.example.test/oauth/token',
    );
    expect(harness.refresh).toHaveBeenLastCalledWith({
      clientId: 'managed-client-id',
      clientSecret: 'provider-client-secret',
      refreshToken: 'provider-refresh-token-v1',
      tokenEndpoint: 'https://identity.example.test/oauth/token',
    });
    expect((await db.select().from(platformUserConnectorBindings))[0]).toMatchObject({
      publishedRevision: 1,
      status: 'connected',
    });
  });

  it('keeps the new binding valid when bounded old-secret cleanup fails', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const authorization = await start(harness, published.draft.id);
    await harness.callback.callback({ code: 'connect', state: authorization.state });
    const oldRef = (await db.select().from(platformUserConnectorBindings))[0]!.oauthTokenRef!;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(harness.secrets, 'revokeSecretRef').mockRejectedValue(
      new Error('secret-store-delete-private-failure'),
    );

    await expect(harness.userA.refreshBinding(published.draft.id)).resolves.toBeUndefined();
    const refreshed = (await db.select().from(platformUserConnectorBindings))[0]!;
    expect(refreshed).toMatchObject({ status: 'connected', userId: userA });
    expect(refreshed.oauthTokenRef).not.toBe(oldRef);
    await expect(
      harness.secrets.resolveSecretRef({
        connectorId: published.draft.id,
        ref: oldRef,
        slot: 'oauthBindingToken',
      }),
    ).resolves.not.toBeNull();

    await expect(harness.userA.disconnect({ connectorId: published.draft.id })).resolves.toEqual({
      disconnected: true,
    });
    expect((await db.select().from(platformUserConnectorBindings))[0]).toMatchObject({
      oauthTokenRef: null,
      status: 'revoked',
    });
  });
});
