/**
 * True multi-connection PostgreSQL evidence for callback/reaper row-lock interleavings.
 * Runs only with TEST_SERVER_DB=1 and DATABASE_TEST_URL; PGlite covers lifecycle outcomes always.
 *
 * @vitest-environment node
 */
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import * as schema from '@/database/schemas';
import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { runIdentityProviderTestAttemptCleanup } from '../../jobs/identityProviderTestAttemptCleanup';
import { IdentityProviderSecretStore } from './secretStore';
import {
  cleanupExpiredIdentityProviderTestAttempts,
  IDENTITY_PROVIDER_TEST_PROCESSING_LEASE_MS,
  IdentityProviderTestAttemptStore,
} from './testAttemptStore';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(53), keyId: 'test-key' }),
  providerId: 'test',
};
const secretService = new PlatformSecretService({ keyProvider });
const secretFingerprint = 'a'.repeat(64);
const secretRef = 'kms://platform-identity-providers/test/secret';

run('IdentityProviderTestAttemptStore — true multi-connection PostgreSQL', () => {
  const connectionString = process.env.DATABASE_TEST_URL!;
  const pools: Pool[] = [];
  let db: LobeChatDatabase;

  const independentDb = (): LobeChatDatabase => {
    const pool = new Pool({ connectionString, max: 1 });
    pools.push(pool);
    return drizzle(pool, { schema }) as unknown as LobeChatDatabase;
  };
  const cleanup = async () => {
    await db.delete(platformIdentityProviderTestAttempts);
    await db.delete(platformIdentityProviderSecrets);
    await db.delete(platformIdentityProviders);
  };
  const issueAndReserve = async () => {
    const [provider] = await db
      .insert(platformIdentityProviders)
      .values({
        displayName: 'Concurrent cleanup',
        providerKey: 'concurrent-cleanup',
        secretFingerprint,
        secretRef,
        secretUpdatedAt: new Date(),
      })
      .returning();
    const store = new IdentityProviderTestAttemptStore(db, secretService);
    const issued = await store.issue({
      auditReason: 'verify callback reaper concurrency',
      providerId: provider.id,
      providerRevision: provider.revision,
      providerSecretFingerprint: secretFingerprint,
      providerSecretRef: secretRef,
      redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
      sessionId: 'session-a',
      userId: 'user-a',
    });
    const reserved = await store.reserve(issued.state);
    const now = new Date();
    await db
      .update(platformIdentityProviderTestAttempts)
      .set({
        reservedAt: new Date(now.getTime() - IDENTITY_PROVIDER_TEST_PROCESSING_LEASE_MS - 1000),
      })
      .where(eq(platformIdentityProviderTestAttempts.id, reserved.id));
    return { now, reserved };
  };

  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    await cleanup();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    await cleanup();
  });
  afterAll(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it('rechecks lifecycle after callback commits first and preserves the fresh outcome', async () => {
    const { now, reserved } = await issueAndReserve();
    let callbackEntered!: () => void;
    let releaseCallback!: () => void;
    const callbackHasLock = new Promise<void>((resolve) => (callbackEntered = resolve));
    const callbackMayCommit = new Promise<void>((resolve) => (releaseCallback = resolve));
    const callbackDb = independentDb();
    const reaperDb = independentDb();
    const callback = callbackDb.transaction(async (tx) => {
      await new IdentityProviderTestAttemptStore(tx, secretService).succeed(reserved, {
        claims: { sub: 'subject' },
        issues: [],
        valid: true,
      });
      callbackEntered();
      await callbackMayCommit;
    });
    await callbackHasLock;
    const reaper = cleanupExpiredIdentityProviderTestAttempts(reaperDb, 500, now);
    await new Promise((resolve) => setTimeout(resolve, 25));

    releaseCallback();

    await expect(callback).resolves.toBeUndefined();
    await expect(reaper).resolves.toBe(0);
    await expect(db.select().from(platformIdentityProviderTestAttempts)).resolves.toEqual([
      expect.objectContaining({ status: 'succeeded' }),
    ]);
  });

  it('lets a committed reaper delete win and makes callback CAS fail', async () => {
    const { now, reserved } = await issueAndReserve();
    let reaperEntered!: () => void;
    let releaseReaper!: () => void;
    const reaperHasLock = new Promise<void>((resolve) => (reaperEntered = resolve));
    const reaperMayCommit = new Promise<void>((resolve) => (releaseReaper = resolve));
    const callbackDb = independentDb();
    const reaperDb = independentDb();
    const reaper = reaperDb.transaction(async (tx) => {
      const deleted = await cleanupExpiredIdentityProviderTestAttempts(tx, 500, now);
      reaperEntered();
      await reaperMayCommit;
      return deleted;
    });
    await reaperHasLock;
    const callback = new IdentityProviderTestAttemptStore(callbackDb, secretService).succeed(
      reserved,
      { claims: { sub: 'subject' }, issues: [], valid: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    releaseReaper();

    await expect(reaper).resolves.toBe(1);
    await expect(callback).rejects.toMatchObject({ code: 'OIDC_TEST_PROVIDER_CHANGED' });
    await expect(db.select().from(platformIdentityProviderTestAttempts)).resolves.toHaveLength(0);
  });

  it('serializes duplicate scheduled cleanup invocations with the advisory lock', async () => {
    await issueAndReserve();
    let activeCleanups = 0;
    let maxActiveCleanups = 0;
    const cleanupWithConcurrencyEvidence = async (tx: Transaction) => {
      activeCleanups += 1;
      maxActiveCleanups = Math.max(maxActiveCleanups, activeCleanups);
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return await cleanupExpiredIdentityProviderTestAttempts(tx);
      } finally {
        activeCleanups -= 1;
      }
    };

    const results = await Promise.all([
      runIdentityProviderTestAttemptCleanup({
        acquireDatabase: async () => independentDb(),
        cleanup: cleanupWithConcurrencyEvidence,
      }),
      runIdentityProviderTestAttemptCleanup({
        acquireDatabase: async () => independentDb(),
        cleanup: cleanupWithConcurrencyEvidence,
      }),
    ]);

    expect(results.toSorted()).toEqual([0, 1]);
    expect(maxActiveCleanups).toBe(1);
  });

  /**
   * Merged from secretStore.pgConcurrency.test.ts so the PostgreSQL failure-drill
   * suite always covers independent-connection secret CAS (identity/F11).
   */
  it('allows exactly one secret writer across independent database connections', async () => {
    const firstStore = new IdentityProviderSecretStore(
      independentDb(),
      new PlatformSecretService({ keyProvider }),
    );
    const secondStore = new IdentityProviderSecretStore(
      independentDb(),
      new PlatformSecretService({ keyProvider }),
    );
    const [provider] = await db
      .insert(platformIdentityProviders)
      .values({ displayName: 'Concurrent secret', providerKey: `concurrent-${randomUUID()}` })
      .returning();
    const results = await Promise.allSettled([
      firstStore.persistClientSecret({
        expectedRevision: 0,
        providerId: provider.id,
        value: randomUUID(),
      }),
      secondStore.persistClientSecret({
        expectedRevision: 0,
        providerId: provider.id,
        value: randomUUID(),
      }),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'PLATFORM_REVISION_CONFLICT' }),
      }),
    ]);
    const [current] = await db
      .select({ revision: platformIdentityProviders.revision })
      .from(platformIdentityProviders)
      .where(eq(platformIdentityProviders.id, provider.id));
    expect(current.revision).toBe(1);
  }, 20_000);
});
