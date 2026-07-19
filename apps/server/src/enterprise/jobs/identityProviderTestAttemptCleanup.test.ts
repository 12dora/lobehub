// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformIdentityProviders,
  platformIdentityProviderTestAttempts,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  cleanupExpiredIdentityProviderTestAttempts,
  IDENTITY_PROVIDER_TEST_PROCESSING_LEASE_MS,
} from '../services/identityProvider/testAttemptStore';
import { runIdentityProviderTestAttemptCleanup } from './identityProviderTestAttemptCleanup';

const db: LobeChatDatabase = await getTestDB();
const secretFingerprint = 'a'.repeat(64);
const secretRef = 'kms://platform-identity-providers/test/secret';
const execFileAsync = promisify(execFile);

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
    const acquireDatabase = vi.fn().mockRejectedValue(new Error('database must not be accessed'));

    await expect(runIdentityProviderTestAttemptCleanup({ acquireDatabase })).resolves.toBe(0);
    expect(acquireDatabase).not.toHaveBeenCalled();
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

    const run = () =>
      runIdentityProviderTestAttemptCleanup({
        acquireDatabase: async () => db,
        acquireLock: async () => {},
        cleanup: (tx) => cleanupExpiredIdentityProviderTestAttempts(tx),
      });
    await expect(run()).resolves.toBe(1);
    await expect(run()).resolves.toBe(0);
    await expect(db.select().from(platformIdentityProviderTestAttempts)).resolves.toHaveLength(0);
  });

  it('imports and remains idle in production with the flag off and no database secrets', async () => {
    const moduleUrl = new URL('./identityProviderTestAttemptCleanup.ts', import.meta.url).href;
    const script = `
      globalThis.setTimeout = () => { throw new Error('timer must not be created'); };
      const job = await import(${JSON.stringify(moduleUrl)});
      job.ensureIdentityProviderTestAttemptCleanupStarted();
      const deleted = await job.runIdentityProviderTestAttemptCleanup();
      if (deleted !== 0) throw new Error('flag-off cleanup must be empty');
      process.stdout.write('flag-off-import-ok');
    `;
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.KEY_VAULTS_SECRET;
    Object.assign(env, {
      ENABLE_DATABASE_OIDC: '0',
      NEXT_RUNTIME: 'nodejs',
      NODE_ENV: 'production',
    });
    const { stderr, stdout } = await execFileAsync('bun', ['--eval', script], {
      cwd: process.cwd(),
      env,
    });

    expect({ stderr, stdout }).toEqual({ stderr: '', stdout: 'flag-off-import-ok' });
  });
});
