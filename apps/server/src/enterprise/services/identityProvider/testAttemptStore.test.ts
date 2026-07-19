// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformIdentityProviders,
  platformIdentityProviderTestAttempts,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { IdentityProviderTestAttemptStore } from './testAttemptStore';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(37), keyId: 'test-key' }),
  providerId: 'test',
};
const store = new IdentityProviderTestAttemptStore(db, new PlatformSecretService({ keyProvider }));

const cleanup = async () => {
  await db.delete(platformIdentityProviderTestAttempts);
  await db.delete(platformIdentityProviders);
};

beforeEach(cleanup);
afterEach(cleanup);

const issue = async () => {
  const [provider] = await db
    .insert(platformIdentityProviders)
    .values({ displayName: 'Work', providerKey: 'work' })
    .returning();
  return store.issue({
    providerId: provider.id,
    providerRevision: provider.revision,
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

  it('binds result reads to both authenticated user and session', async () => {
    const issued = await issue();
    const reserved = await store.reserve(issued.state);
    await store.succeed(reserved.id, { claims: { sub: 'subject' }, issues: [], valid: true });
    await expect(
      store.getResult({ attemptId: issued.attemptId, sessionId: 'session-b', userId: 'user-a' }),
    ).resolves.toBeUndefined();
    await expect(
      store.getResult({ attemptId: issued.attemptId, sessionId: 'session-a', userId: 'user-b' }),
    ).resolves.toBeUndefined();
    await expect(
      store.getResult({ attemptId: issued.attemptId, sessionId: 'session-a', userId: 'user-a' }),
    ).resolves.toMatchObject({ status: 'succeeded' });
  });
});
