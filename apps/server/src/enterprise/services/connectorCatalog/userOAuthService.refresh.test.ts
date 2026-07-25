// @vitest-environment node
import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  platformAuditLogs,
  platformJobs,
  platformUserConnectorBindings,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';

import { cleanupM09ServiceData } from './catalogTestUtils';
import {
  createHarness,
  db,
  publishOAuthConnector,
  publishWithConnectionTest,
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

describe('per-user connector OAuth refresh/concurrency', () => {
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

  it('expired_running_refresh_lease_can_be_recovered_after_crash', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const authorization = await start(harness, published.draft.id);
    await harness.callback.callback({ code: 'connect', state: authorization.state });
    const [binding] = await db.select().from(platformUserConnectorBindings);
    expect(binding).toBeTruthy();

    // Simulate a crashed worker that held the lease but never started outbound I/O.
    const idempotencyKey = createHash('sha256')
      .update(`${binding!.id}:${binding!.revision}`)
      .digest('hex');
    await db.insert(platformJobs).values({
      attempt: 1,
      heartbeatAt: new Date(Date.now() - 10 * 60 * 1000),
      idempotencyKey,
      input: {
        bindingId: binding!.id,
        bindingRevision: binding!.revision,
        connectorId: binding!.connectorId,
        outboundStarted: false,
        userId: binding!.userId,
      },
      leaseOwner: 'crashed-worker',
      leaseUntil: new Date(Date.now() - 5 * 60 * 1000),
      requestedBy: binding!.userId,
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
      status: 'running',
      type: 'connector.oauth.refresh.v1',
    });

    await expect(harness.userA.refreshBinding(published.draft.id)).resolves.toBeUndefined();
    expect(harness.refresh).toHaveBeenCalledOnce();
  });

  it('stale_worker_heartbeat_loss_never_calls_outbound_refresh', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const authorization = await start(harness, published.draft.id);
    await harness.callback.callback({ code: 'connect', state: authorization.state });

    // After acquisition, transfer the lease to another worker so the pre-outbound
    // heartbeat matches zero rows and must refuse IdP I/O.
    harness.dependencies.__testAfterRefreshLeaseAcquire = async (lease) => {
      await db
        .update(platformJobs)
        .set({ leaseOwner: 'reclaim-worker-b' })
        .where(eq(platformJobs.id, lease.jobId));
    };

    await expect(harness.userA.refreshBinding(published.draft.id)).rejects.toMatchObject({
      code: 'PLATFORM_CONNECTOR_RESOURCE_MISMATCH',
    });
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it('post_outbound_heartbeat_loss_still_persists_rotated_credential', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const authorization = await start(harness, published.draft.id);
    await harness.callback.callback({ code: 'connect', state: authorization.state });
    const [before] = await db.select().from(platformUserConnectorBindings);
    expect(before?.oauthTokenRef).toBeTruthy();
    const originalRef = before!.oauthTokenRef!;

    // Steal lease ownership during outbound I/O so the post-outbound heartbeat
    // loses ownership. The rotated pair must still land on the binding (CAS fence)
    // rather than being discarded while the IdP has already consumed the old RT.
    harness.refresh.mockImplementation(async () => {
      await db
        .update(platformJobs)
        .set({ leaseOwner: 'post-outbound-thief' })
        .where(eq(platformJobs.type, 'connector.oauth.refresh.v1'));
      return {
        body: {
          access_token: 'provider-access-token-post-outbound',
          expires_in: 7200,
          refresh_token: 'provider-refresh-token-post-outbound',
          scope: 'issues:read',
          token_type: 'Bearer',
        },
        status: 200,
        url: 'https://identity.example.test/oauth/token',
      };
    });

    // Post-outbound ownership loss: binding CAS still commits; complete() miss
    // is soft-success (rotated credential is durable) rather than a hard error.
    await expect(harness.userA.refreshBinding(published.draft.id)).resolves.toBeUndefined();
    expect(harness.refresh).toHaveBeenCalledOnce();

    const [after] = await db.select().from(platformUserConnectorBindings);
    expect(after?.status).toBe('connected');
    expect(after?.oauthTokenRef).toBeTruthy();
    expect(after!.oauthTokenRef).not.toBe(originalRef);

    const rotated = await harness.secrets.resolveSecretRef({
      connectorId: published.draft.id,
      ref: after!.oauthTokenRef!,
      slot: 'oauthBindingToken',
    });
    expect(rotated?.value).toMatchObject({
      accessToken: 'provider-access-token-post-outbound',
      refreshToken: 'provider-refresh-token-post-outbound',
    });
  });

  it('expired_outbound_refresh_lease_is_ambiguous_and_not_retried', async () => {
    const harness = createHarness();
    const published = await publishOAuthConnector(harness);
    const authorization = await start(harness, published.draft.id);
    await harness.callback.callback({ code: 'connect', state: authorization.state });
    const [binding] = await db.select().from(platformUserConnectorBindings);
    const idempotencyKey = createHash('sha256')
      .update(`${binding!.id}:${binding!.revision}`)
      .digest('hex');
    await db.insert(platformJobs).values({
      attempt: 1,
      heartbeatAt: new Date(Date.now() - 15 * 60 * 1000),
      idempotencyKey,
      input: {
        bindingId: binding!.id,
        bindingRevision: binding!.revision,
        connectorId: binding!.connectorId,
        outboundStarted: true,
        userId: binding!.userId,
      },
      leaseOwner: 'crashed-mid-outbound',
      leaseUntil: new Date(Date.now() - 5 * 60 * 1000),
      requestedBy: binding!.userId,
      startedAt: new Date(Date.now() - 15 * 60 * 1000),
      status: 'running',
      type: 'connector.oauth.refresh.v1',
    });

    await expect(harness.userA.refreshBinding(published.draft.id)).rejects.toMatchObject({
      code: 'PLATFORM_CONNECTOR_RESOURCE_MISMATCH',
    });
    expect(harness.refresh).not.toHaveBeenCalled();
    const [job] = await db
      .select()
      .from(platformJobs)
      .where(eq(platformJobs.idempotencyKey, idempotencyKey));
    expect(job).toMatchObject({
      lastError: { code: 'CONNECTOR_OAUTH_REFRESH_AMBIGUOUS_OUTBOUND' },
      status: 'dead',
    });
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
    await publishWithConnectionTest(harness, {
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
});
