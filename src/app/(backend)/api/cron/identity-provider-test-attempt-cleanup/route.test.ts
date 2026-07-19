// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformIdentityProviders,
  platformIdentityProviderTestAttempts,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { runIdentityProviderTestAttemptCleanup } from '@/server/enterprise/jobs/identityProviderTestAttemptCleanup';
import {
  cleanupExpiredIdentityProviderTestAttempts,
  IDENTITY_PROVIDER_TEST_PROCESSING_LEASE_MS,
} from '@/server/enterprise/services/identityProvider/testAttemptStore';

import { createIdentityProviderTestAttemptCleanupHandler, GET } from './route';

const db: LobeChatDatabase = await getTestDB();
const endpoint = 'https://app.example.test/api/cron/identity-provider-test-attempt-cleanup';
const secretFingerprint = 'a'.repeat(64);
const secretRef = 'kms://platform-identity-providers/test/secret';

const cleanup = async () => {
  await db.delete(platformIdentityProviderTestAttempts);
  await db.delete(platformIdentityProviders);
};

beforeEach(cleanup);
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanup();
});

describe('identity provider test attempt cleanup cron', () => {
  it.each([
    { authorization: undefined, cronSecret: undefined, label: 'missing server secret' },
    { authorization: undefined, cronSecret: 'cron-secret', label: 'missing authorization' },
    { authorization: 'Bearer wrong', cronSecret: 'cron-secret', label: 'wrong authorization' },
  ])('fails closed for $label before invoking cleanup', async ({ authorization, cronSecret }) => {
    if (cronSecret) vi.stubEnv('CRON_SECRET', cronSecret);
    const runCleanup = vi.fn().mockResolvedValue(0);
    const handler = createIdentityProviderTestAttemptCleanupHandler({ runCleanup });
    const headers = authorization ? { Authorization: authorization } : undefined;

    const response = await handler(new Request(endpoint, { headers }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it('returns successfully with zero DB acquisition when authenticated but feature-off', async () => {
    vi.stubEnv('CRON_SECRET', 'cron-secret');
    vi.stubEnv('ENABLE_DATABASE_OIDC', '0');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('KEY_VAULTS_SECRET', '');

    const response = await GET(
      new Request(endpoint, { headers: { Authorization: 'Bearer cron-secret' } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ deleted: 0 });
  });

  it('runs the bounded job and removes a stale processing attempt', async () => {
    vi.stubEnv('CRON_SECRET', 'cron-secret');
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    const [provider] = await db
      .insert(platformIdentityProviders)
      .values({
        displayName: 'Cron cleanup',
        providerKey: 'cron-cleanup',
        secretFingerprint,
        secretRef,
        secretUpdatedAt: new Date(),
      })
      .returning();
    const createdAt = new Date(Date.now() - 30 * 60 * 1000);
    await db.insert(platformIdentityProviderTestAttempts).values({
      auditReason: 'scheduled stale attempt cleanup',
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
      sessionId: 'cron-session',
      stateHash: 'd'.repeat(64),
      status: 'processing',
      userId: 'cron-user',
    });
    const acquireLock = vi.fn().mockResolvedValue(undefined);
    const handler = createIdentityProviderTestAttemptCleanupHandler({
      runCleanup: () =>
        runIdentityProviderTestAttemptCleanup({
          acquireDatabase: async () => db,
          acquireLock,
          cleanup: (tx) => cleanupExpiredIdentityProviderTestAttempts(tx),
        }),
    });

    const response = await handler(
      new Request(endpoint, { headers: { Authorization: 'Bearer cron-secret' } }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: 1 });
    expect(acquireLock).toHaveBeenCalledOnce();
    await expect(db.select().from(platformIdentityProviderTestAttempts)).resolves.toHaveLength(0);
  });

  it('returns a sanitized server error when scheduled cleanup fails', async () => {
    vi.stubEnv('CRON_SECRET', 'cron-secret');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = createIdentityProviderTestAttemptCleanupHandler({
      runCleanup: async () => {
        throw new Error('database details must not be reflected');
      },
    });

    const response = await handler(
      new Request(endpoint, { headers: { Authorization: 'Bearer cron-secret' } }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'cleanup_failed' });
    expect(errorSpy).toHaveBeenCalledWith(
      '[identity-provider-test-attempt-cleanup] scheduled cleanup failed',
      { errorClass: 'Error' },
    );
  });

  it('is registered as a five-minute Vercel Cron schedule', async () => {
    const config = JSON.parse(await readFile(path.join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons?: Array<{ path: string; schedule: string }>;
    };

    expect(config.crons).toContainEqual({
      path: '/api/cron/identity-provider-test-attempt-cleanup',
      schedule: '*/5 * * * *',
    });
  });
});
