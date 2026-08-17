// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformIdentityProviders,
  platformIdentityProviderTestAttempts,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import {
  IDENTITY_PROVIDER_TEST_PROCESSING_LEASE_MS,
  IDENTITY_PROVIDER_TEST_TERMINAL_RETENTION_MS,
  IdentityProviderTestAttemptStore,
} from './testAttemptStore';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(37), keyId: 'test-key' }),
  providerId: 'test',
};
const store = new IdentityProviderTestAttemptStore(db, new PlatformSecretService({ keyProvider }));
const secretFingerprint = 'a'.repeat(64);
const secretRef = 'kms://platform-identity-providers/test/secret';

const cleanup = async () => {
  await db.delete(platformIdentityProviderTestAttempts);
  await db.delete(platformIdentityProviders);
};

beforeEach(cleanup);
afterEach(cleanup);

const issue = async () => {
  const [provider] = await db
    .insert(platformIdentityProviders)
    .values({
      displayName: 'Work',
      providerKey: 'work',
      secretFingerprint,
      secretRef,
      secretUpdatedAt: new Date(),
    })
    .returning();
  return store.issue({
    auditReason: 'test work identity provider',
    providerId: provider.id,
    providerRevision: provider.revision,
    providerSecretFingerprint: secretFingerprint,
    providerSecretRef: secretRef,
    redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
    sessionId: 'session-a',
    userId: 'user-a',
  });
};

describe('IdentityProviderTestAttemptStore', () => {
  it('stores only state/nonce hashes and encrypted PKCE, then reserves once', async () => {
    const issued = await issue();
    const [persisted] = await db.select().from(platformIdentityProviderTestAttempts);
    expect(JSON.stringify(persisted)).not.toContain(issued.state);
    expect(JSON.stringify(persisted)).not.toContain(issued.nonce);
    expect(persisted.pkceCiphertext).toMatch(/^aihub\.secret\.v1\./);

    const reserved = await store.reserve(issued.state);
    expect(reserved.pkceVerifier).toHaveLength(43);
    await expect(store.reserve(issued.state)).rejects.toMatchObject({ code: 'OIDC_TEST_REPLAYED' });
  });

  it('rejects tampered state and allows only one concurrent reservation', async () => {
    const issued = await issue();
    await expect(store.reserve(`${issued.state}x`)).rejects.toMatchObject({
      code: 'OIDC_TEST_INVALID_STATE',
    });
    const outcomes = await Promise.allSettled([
      store.reserve(issued.state),
      store.reserve(issued.state),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
  });

  it('rejects expired attempts without transitioning them to processing', async () => {
    const issued = await issue();
    const createdAt = new Date(Date.now() - 10 * 60 * 1000);
    await db
      .update(platformIdentityProviderTestAttempts)
      .set({ createdAt, expiresAt: new Date(createdAt.getTime() + 5 * 60 * 1000) });
    await expect(store.reserve(issued.state)).rejects.toMatchObject({ code: 'OIDC_TEST_EXPIRED' });
    const [row] = await db.select().from(platformIdentityProviderTestAttempts);
    expect(row.status).toBe('pending');
  });

  it('binds result reads to the authenticated user, not the issuing session', async () => {
    const issued = await issue();
    const reserved = await store.reserve(issued.state);
    await store.succeed(reserved, { claims: { sub: 'subject' }, issues: [], valid: true });
    // Same user, rotated session — must still collect the in-flight result.
    await expect(
      store.getResult({ attemptId: issued.attemptId, sessionId: 'session-b', userId: 'user-a' }),
    ).resolves.toMatchObject({ status: 'succeeded' });
    await expect(
      store.getResult({ attemptId: issued.attemptId, sessionId: 'session-a', userId: 'user-b' }),
    ).resolves.toBeUndefined();
    await expect(
      store.getResult({ attemptId: issued.attemptId, sessionId: 'session-a', userId: 'user-a' }),
    ).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('cannot persist an invalid claim preview as a successful test', async () => {
    const issued = await issue();
    const reserved = await store.reserve(issued.state);
    await expect(
      store.succeed(reserved, {
        claims: {},
        issues: [{ code: 'required_claim_missing', field: 'subject' }],
        valid: false,
      }),
    ).rejects.toMatchObject({ code: 'OIDC_TEST_CLAIM_VALIDATION_FAILED' });
    await expect(
      store.getResult({ attemptId: issued.attemptId, sessionId: 'session-a', userId: 'user-a' }),
    ).resolves.toMatchObject({
      errorCode: 'OIDC_TEST_CLAIM_VALIDATION_FAILED',
      status: 'failed',
    });
  });

  it('turns an expired in-flight callback into a terminal failure', async () => {
    const issued = await issue();
    const reserved = await store.reserve(issued.state);
    const createdAt = new Date(Date.now() - 10 * 60_000);
    await db
      .update(platformIdentityProviderTestAttempts)
      .set({ createdAt, expiresAt: new Date(createdAt.getTime() + 5 * 60_000) })
      .where(eq(platformIdentityProviderTestAttempts.id, issued.attemptId));

    await expect(
      store.succeed(reserved, { claims: { sub: 'subject' }, issues: [], valid: true }),
    ).rejects.toMatchObject({ code: 'OIDC_TEST_EXPIRED' });
    await expect(
      store.getResult({ attemptId: issued.attemptId, sessionId: 'session-a', userId: 'user-a' }),
    ).resolves.toMatchObject({ errorCode: 'OIDC_TEST_EXPIRED', status: 'failed' });
  });

  it('atomically rejects provider revision and secret-version races', async () => {
    const issued = await issue();
    const reserved = await store.reserve(issued.state);
    await db
      .update(platformIdentityProviders)
      .set({ revision: 1, secretFingerprint: 'b'.repeat(64), secretRef: `${secretRef}-rotated` });
    await expect(
      store.succeed(reserved, { claims: { sub: 'subject' }, issues: [], valid: true }),
    ).rejects.toMatchObject({ code: 'OIDC_TEST_PROVIDER_CHANGED' });
    await store.fail(reserved.id, 'OIDC_TEST_PROVIDER_CHANGED');
    await expect(
      store.getResult({ attemptId: issued.attemptId, sessionId: 'session-a', userId: 'user-a' }),
    ).resolves.toMatchObject({ errorCode: 'OIDC_TEST_PROVIDER_CHANGED', status: 'failed' });
  });

  it('rejects a secret-only race even when the provider revision was not advanced', async () => {
    const issued = await issue();
    const reserved = await store.reserve(issued.state);
    await db
      .update(platformIdentityProviders)
      .set({ secretFingerprint: 'c'.repeat(64), secretRef: `${secretRef}-other` });
    await expect(
      store.succeed(reserved, { claims: { sub: 'subject' }, issues: [], valid: true }),
    ).rejects.toMatchObject({ code: 'OIDC_TEST_PROVIDER_CHANGED' });
  });

  it('treats a previously succeeded result as stale after provider mutation', async () => {
    const issued = await issue();
    const reserved = await store.reserve(issued.state);
    await store.succeed(reserved, { claims: { sub: 'subject' }, issues: [], valid: true });
    await db.update(platformIdentityProviders).set({ revision: 1 });
    await expect(
      store.getResult({ attemptId: issued.attemptId, sessionId: 'session-a', userId: 'user-a' }),
    ).resolves.toEqual({
      attemptId: issued.attemptId,
      errorCode: 'OIDC_TEST_PROVIDER_CHANGED',
      result: null,
      status: 'failed',
    });
  });

  it('keeps an active processing lease and reaps stale processing plus retained terminal rows', async () => {
    const [provider] = await db
      .insert(platformIdentityProviders)
      .values({
        displayName: 'Cleanup',
        providerKey: 'cleanup',
        secretFingerprint,
        secretRef,
        secretUpdatedAt: new Date(),
      })
      .returning();
    const now = new Date();
    const createdAt = new Date(now.getTime() - 30 * 60 * 1000);
    const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
    const staleReservedAt = new Date(
      now.getTime() - IDENTITY_PROVIDER_TEST_PROCESSING_LEASE_MS - 1000,
    );
    const retainedUntil = new Date(
      now.getTime() - IDENTITY_PROVIDER_TEST_TERMINAL_RETENTION_MS - 1000,
    );
    const base = (index: number) => ({
      auditReason: 'cleanup expired identity provider test',
      createdAt,
      expiresAt,
      nonceHash: 'b'.repeat(64),
      pkceCiphertext: 'encrypted',
      pkceKeyId: 'test-key',
      providerId: provider.id,
      providerRevision: 0,
      providerSecretFingerprint: secretFingerprint,
      providerSecretRef: secretRef,
      redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
      sessionId: 'cleanup-session',
      stateHash: index.toString(16).padStart(64, '0'),
      userId: 'cleanup-user',
    });
    await db.insert(platformIdentityProviderTestAttempts).values([
      ...Array.from({ length: 502 }, (_, index) => base(index + 1)),
      {
        ...base(503),
        completedAt: retainedUntil,
        errorCode: 'OIDC_TEST_FAILED',
        status: 'failed' as const,
      },
      {
        ...base(504),
        completedAt: retainedUntil,
        result: { claims: {}, issues: [], valid: true },
        status: 'succeeded' as const,
      },
      { ...base(505), reservedAt: staleReservedAt, status: 'processing' as const },
      { ...base(506), reservedAt: now, status: 'processing' as const },
    ]);

    await expect(store.cleanupExpired(1000, now)).resolves.toBe(500);
    await expect(store.cleanupExpired(1000, now)).resolves.toBe(5);
    await expect(store.cleanupExpired(1000, now)).resolves.toBe(0);
    const remaining = await db.select().from(platformIdentityProviderTestAttempts);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe('processing');
    expect(remaining[0].stateHash).toBe(base(506).stateHash);
  });

  it('preserves a callback outcome when callback wins the stale-lease interleaving', async () => {
    const issued = await issue();
    const reserved = await store.reserve(issued.state);
    const now = new Date();
    await db.update(platformIdentityProviderTestAttempts).set({
      reservedAt: new Date(now.getTime() - IDENTITY_PROVIDER_TEST_PROCESSING_LEASE_MS - 1000),
    });

    await store.succeed(reserved, { claims: { sub: 'subject' }, issues: [], valid: true });

    await expect(store.cleanupExpired(500, now)).resolves.toBe(0);
    await expect(
      store.getResult({ attemptId: issued.attemptId, sessionId: 'session-a', userId: 'user-a' }),
    ).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('prevents callback completion when the reaper wins the stale-lease interleaving', async () => {
    const issued = await issue();
    const reserved = await store.reserve(issued.state);
    const now = new Date();
    await db.update(platformIdentityProviderTestAttempts).set({
      reservedAt: new Date(now.getTime() - IDENTITY_PROVIDER_TEST_PROCESSING_LEASE_MS - 1000),
    });

    await expect(store.cleanupExpired(500, now)).resolves.toBe(1);
    await expect(
      store.succeed(reserved, { claims: { sub: 'subject' }, issues: [], valid: true }),
    ).rejects.toMatchObject({ code: 'OIDC_TEST_PROVIDER_CHANGED' });
    await expect(store.cleanupExpired(500, now)).resolves.toBe(0);
    await expect(
      store.getResult({ attemptId: issued.attemptId, sessionId: 'session-a', userId: 'user-a' }),
    ).resolves.toBeUndefined();
  });
});
