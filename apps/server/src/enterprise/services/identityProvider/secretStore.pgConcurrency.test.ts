// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import * as schema from '@/database/schemas';
import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { IdentityProviderSecretStore } from './secretStore';

const runPostgresConcurrency = process.env.TEST_SERVER_DB === '1';
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(41), keyId: 'pg-cas-key' }),
  providerId: 'pg-cas',
};

describe.skipIf(!runPostgresConcurrency)('IdentityProviderSecretStore PostgreSQL CAS', () => {
  it('allows exactly one writer across independent database connections', async () => {
    const adminDb = await getTestDB();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const firstPool = new Pool({ connectionString, max: 1 });
    const secondPool = new Pool({ connectionString, max: 1 });
    const firstStore = new IdentityProviderSecretStore(
      drizzle(firstPool, { schema }) as unknown as LobeChatDatabase,
      new PlatformSecretService({ keyProvider }),
    );
    const secondStore = new IdentityProviderSecretStore(
      drizzle(secondPool, { schema }) as unknown as LobeChatDatabase,
      new PlatformSecretService({ keyProvider }),
    );
    try {
      await adminDb.delete(platformIdentityProviderSecrets);
      await adminDb.delete(platformIdentityProviders);
      const [provider] = await adminDb
        .insert(platformIdentityProviders)
        .values({ displayName: 'Concurrent', providerKey: `concurrent-${randomUUID()}` })
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
      const [current] = await adminDb
        .select({ revision: platformIdentityProviders.revision })
        .from(platformIdentityProviders);
      expect(current.revision).toBe(1);
    } finally {
      await firstPool.end();
      await secondPool.end();
      await adminDb.delete(platformIdentityProviderSecrets);
      await adminDb.delete(platformIdentityProviders);
    }
  }, 20_000);
});
