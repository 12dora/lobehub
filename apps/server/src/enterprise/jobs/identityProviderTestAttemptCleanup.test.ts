// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformIdentityProviders,
  platformIdentityProviderTestAttempts,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { IDENTITY_PROVIDER_TEST_PROCESSING_LEASE_MS } from '../services/identityProvider/testAttemptStore';
import { runIdentityProviderTestAttemptCleanup } from './identityProviderTestAttemptCleanup';

const db: LobeChatDatabase = await getTestDB();
const secretFingerprint = 'a'.repeat(64);
const secretRef = 'kms://platform-identity-providers/test/secret';

const cleanup = async () => {
  await db.delete(platformIdentityProviderTestAttempts);
  await db.delete(platformIdentityProviders);
};

beforeEach(cleanup);
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

describe('runIdentityProviderTestAttemptCleanup', () => {
  it('performs zero database work when database OIDC is disabled', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '0');
    const unusedDb = new Proxy(
      {},
      {
        get: () => {
          throw new Error('database must not be accessed');
        },
      },
    ) as LobeChatDatabase;

    await expect(runIdentityProviderTestAttemptCleanup(unusedDb)).resolves.toBe(0);
  });

  it('provides a scheduler entry point that reaps a stale processing lease', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
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
    const createdAt = new Date(Date.now() - 30 * 60 * 1000);
    await db.insert(platformIdentityProviderTestAttempts).values({
      auditReason: 'periodic cleanup identity provider test',
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 5 * 60 * 1000),
      nonceHash: 'b'.repeat(64),
      pkceCiphertext: 'encrypted-pkce-must-be-reaped',
      pkceKeyId: 'test-key',
      providerId: provider.id,
      providerRevision: 0,
      providerSecretFingerprint: secretFingerprint,
      providerSecretRef: secretRef,
      redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
      reservedAt: new Date(Date.now() - IDENTITY_PROVIDER_TEST_PROCESSING_LEASE_MS - 1000),
      sessionId: 'cleanup-session',
      stateHash: 'c'.repeat(64),
      status: 'processing',
      userId: 'cleanup-user',
    });

    await expect(runIdentityProviderTestAttemptCleanup(db)).resolves.toBe(1);
    await expect(runIdentityProviderTestAttemptCleanup(db)).resolves.toBe(0);
    await expect(db.select().from(platformIdentityProviderTestAttempts)).resolves.toHaveLength(0);
  });
});
