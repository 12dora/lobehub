// @vitest-environment node
import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  platformAuditLogs,
  platformConnectorOAuthStates,
  platformConnectors,
  platformResourceRevisions,
  platformUserConnectorBindings,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';

import { cleanupM09ServiceData } from './catalogTestUtils';
import { MANAGED_CONNECTOR_OAUTH_STATE_PREFIX } from './oauthRuntime';
import { UserConnectorOAuthService } from './userOAuthService';
import {
  callbackRedirectUri,
  createHarness,
  db,
  publishOAuthConnector,
  start,
  userA,
  userB,
} from './userOAuthService.test.harness';

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

describe('per-user connector OAuth authorization/callback', () => {
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

  it('returns invalid for an unknown authorization attempt', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const attemptId = 'a'.repeat(32);
    await expect(
      harness.userA.getAuthorizationStatus({
        attemptId,
        connectorId: published.draft.id,
      }),
    ).resolves.toEqual({
      attemptId,
      binding: null,
      status: 'invalid',
    });
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
});
