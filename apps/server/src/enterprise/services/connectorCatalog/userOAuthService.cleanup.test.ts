// @vitest-environment node
import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  platformConnectorOAuthStates,
  platformConnectors,
  platformConnectorSecrets,
  platformUserConnectorBindings,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';

import { type KeyProvider, PlatformSecretService } from '../../security/secret';
import { cleanupM09ServiceData } from './catalogTestUtils';
import { PlatformConnectorSecretStore } from './platformConnectorSecretStore';
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

describe('per-user connector OAuth cleanup/history', () => {
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
