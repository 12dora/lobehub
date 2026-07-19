// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import {
  identityProviderLkgGeneration,
  identityProviderLkgIdentity,
  readIdentityProviderLkg,
} from './lkg';
import type { PublishedIdentityProviderPayload } from './publicationService';
import {
  acquireIdentityProviderLkgAdvisoryLock,
  loadIdentityProviderStartupSnapshot,
  resetIdentityProviderStartupSnapshotForTest,
  withIdentityProviderLkgAdvisoryLock,
} from './startupSnapshot';

const db: LobeChatDatabase = await getTestDB();
const masterKey = Buffer.alloc(32, 88).toString('base64');
const directories: string[] = [];

const discovery = {
  discover: async (issuer: string) => ({
    authorizationEndpoint: 'https://login.example.test/authorize',
    codeChallengeMethodsSupported: ['S256'],
    idTokenSigningAlgValuesSupported: ['RS256'],
    issuer,
    jwksUri: 'https://login.example.test/jwks',
    responseTypesSupported: ['code'],
    scopesSupported: ['openid', 'profile', 'email', 'dingtalk'],
    subjectTypesSupported: ['public'],
    tokenEndpoint: 'https://login.example.test/token',
    tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
    userinfoEndpoint: 'https://login.example.test/userinfo',
  }),
};

const loadSnapshot = (options: Parameters<typeof loadIdentityProviderStartupSnapshot>[0] = {}) =>
  loadIdentityProviderStartupSnapshot({ ...options, discovery });

const baseEnv = async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'aihub-oidc-startup-'));
  directories.push(directory);
  return {
    AUTH_DISABLE_EMAIL_PASSWORD: '0',
    AUTH_SSO_PROVIDERS: '',
    ENABLE_DATABASE_OIDC: '1',
    PLATFORM_MASTER_KEY: masterKey,
    PLATFORM_MASTER_KEY_ID: 'env:startup-test',
    PLATFORM_OIDC_LKG_PATH: path.join(directory, 'snapshot.json'),
  };
};

const payload = (
  providerKey = 'work',
): PublishedIdentityProviderPayload & { secretUpdatedAt: string } => ({
  autoProvision: true,
  buttonLabel: 'Sign in with work',
  claimMapping: {
    dingtalkTitle: ['dingtalk_title'],
    dingtalkUserId: ['dingtalk_user_id'],
    email: ['email'],
    name: ['name', 'preferred_username'],
    picture: ['picture'],
    subject: ['sub'],
  },
  clientId: 'client-id',
  displayName: 'Work',
  domainAllowlist: [],
  enabled: true,
  groupRoleMapping: {},
  icon: null,
  issuer: 'https://login.example.test',
  providerKey,
  scopes: ['openid', 'profile', 'email', 'dingtalk'],
  secretFingerprint: '',
  secretUpdatedAt: '2026-07-19T00:00:00.000Z',
  type: 'authentik',
  usePkce: true,
});

const seedPublished = async (env: Record<string, string | undefined>, providerKey = 'work') => {
  const clientSecret = 'fake-startup-client-secret';
  const secretFingerprint = createHash('sha256').update(clientSecret).digest('hex');
  const secretUpdatedAt = new Date();
  const published = {
    ...payload(providerKey),
    secretFingerprint,
    secretUpdatedAt: secretUpdatedAt.toISOString(),
  };
  const secretService = PlatformSecretService.tryFromEnv(env)!;
  const ciphertext = await secretService.encrypt(clientSecret);
  const [provider] = await db
    .insert(platformIdentityProviders)
    .values({
      activationRevision: 2,
      clientId: published.clientId,
      createdAt: secretUpdatedAt,
      displayName: published.displayName,
      enabled: true,
      issuer: published.issuer,
      providerKey,
      revision: 2,
      secretFingerprint,
      secretRef: `kms://platform-identity-providers/${providerKey}/secret`,
      secretUpdatedAt,
      status: 'pending_restart',
      type: published.type,
    })
    .returning();
  await db.insert(platformIdentityProviderSecrets).values({
    ciphertext,
    createdAt: secretUpdatedAt,
    fingerprint: secretFingerprint,
    keyId: secretService.peekKeyId(ciphertext),
    providerId: provider.id,
    ref: provider.secretRef!,
  });
  await db.insert(platformResourceRevisions).values({
    checksum: checksumPayload(published),
    payload: published,
    publishedAt: new Date(),
    resourceId: provider.id,
    resourceType: 'oidc',
    revision: 2,
    secretFingerprint,
    status: 'published',
  });
  return { clientSecret, provider, published };
};

const publishRevision = async (input: {
  issuer?: string;
  providerId: string;
  providerKey?: string;
  revision: number;
  secretFingerprint: string;
}) => {
  const published = {
    ...payload(input.providerKey),
    issuer: input.issuer ?? 'https://login.example.test',
    secretFingerprint: input.secretFingerprint,
    secretUpdatedAt: new Date().toISOString(),
  };
  await db.insert(platformResourceRevisions).values({
    checksum: checksumPayload(published),
    payload: published,
    publishedAt: new Date(),
    resourceId: input.providerId,
    resourceType: 'oidc',
    revision: input.revision,
    secretFingerprint: input.secretFingerprint,
    status: 'published',
  });
  return published;
};

const cleanup = async () => {
  resetIdentityProviderStartupSnapshotForTest();
  await db.delete(platformIdentityProviderSecrets);
  await db.delete(platformIdentityProviders);
  await db.delete(platformResourceRevisions);
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
};

beforeEach(cleanup);
afterEach(cleanup);

describe('identity provider startup snapshot', () => {
  it.runIf(process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL))(
    'releases the cross-instance advisory lock when the owning PG connection crashes',
    async () => {
      const ownerClient = new Client({ connectionString: process.env.DATABASE_TEST_URL });
      const waiterPool = new Pool({ connectionString: process.env.DATABASE_TEST_URL });
      const adminPool = new Pool({ connectionString: process.env.DATABASE_TEST_URL });
      const waiterDb = drizzle(waiterPool) as unknown as LobeChatDatabase;
      ownerClient.on('error', () => undefined);
      let waiterEntered = false;
      try {
        await ownerClient.connect();
        await ownerClient.query('BEGIN');
        const ownerDb = drizzle(ownerClient) as unknown as LobeChatDatabase;
        await acquireIdentityProviderLkgAdvisoryLock(ownerDb);
        const ownerPid = Number(
          (await ownerClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
        );
        const waiter = withIdentityProviderLkgAdvisoryLock(waiterDb, async () => {
          waiterEntered = true;
          return 'acquired';
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(waiterEntered).toBe(false);

        await adminPool.query('SELECT pg_terminate_backend($1)', [ownerPid]);
        await expect(waiter).resolves.toBe('acquired');
      } finally {
        await ownerClient.end().catch(() => undefined);
        await Promise.all([waiterPool.end(), adminPool.end()]);
      }
    },
  );

  it('has a flag-off zero DB/LKG path', async () => {
    const snapshot = await loadSnapshot({
      cache: false,
      db: new Proxy({} as LobeChatDatabase, {
        get: () => {
          throw new Error('DB_MUST_NOT_BE_TOUCHED');
        },
      }),
      env: { AUTH_SSO_PROVIDERS: 'authentik,google', ENABLE_DATABASE_OIDC: '0' },
    });
    expect(snapshot).toMatchObject({
      databaseProviders: [],
      health: 'healthy',
      providerIds: ['authentik', 'google'],
      source: 'environment',
    });
  });

  it('loads a complete DB snapshot once without fabricating global multi-instance activation', async () => {
    const env = await baseEnv();
    const { clientSecret, provider } = await seedPublished(env);
    const first = await loadSnapshot({ db, env });
    const second = await loadSnapshot({ db, env });

    expect(second).toBe(first);
    expect(first).toMatchObject({ health: 'healthy', providerIds: ['work'], source: 'database' });
    expect(first.databaseProviders[0]).toMatchObject({
      clientSecret,
      providerKey: 'work',
      revision: 2,
    });
    const [activated] = await db.select().from(platformIdentityProviders);
    expect(activated).toMatchObject({ id: provider.id, status: 'pending_restart' });
  });

  it('loads a legacy DB snapshot and its LKG without secretUpdatedAt', async () => {
    const env = await baseEnv();
    const { clientSecret } = await seedPublished(env);
    const [revision] = await db.select().from(platformResourceRevisions);
    const { secretUpdatedAt: _secretUpdatedAt, ...legacyPayload } = revision.payload as Record<
      string,
      unknown
    >;
    await db
      .update(platformResourceRevisions)
      .set({ checksum: checksumPayload(legacyPayload), payload: legacyPayload })
      .where(eq(platformResourceRevisions.id, revision.id));

    const discover = vi.fn(discovery.discover);
    const database = await loadIdentityProviderStartupSnapshot({
      cache: false,
      db,
      discovery: { discover },
      env,
    });
    expect(database).toMatchObject({ health: 'healthy', source: 'database' });
    expect(database.databaseProviders[0]?.clientSecret).toBe(clientSecret);
    expect(database.databaseProviders[0]?.oidcMetadata.issuer).toBe('https://login.example.test');
    const persistedLkg = await readIdentityProviderLkg({
      env,
      secrets: PlatformSecretService.tryFromEnv(env)!,
    });
    expect(persistedLkg?.providers[0]?.payload).not.toHaveProperty('oidcMetadata');
    const unavailableDb = new Proxy({} as LobeChatDatabase, {
      get: () => {
        throw new Error('DATABASE_UNAVAILABLE');
      },
    });
    const lkg = await loadIdentityProviderStartupSnapshot({
      cache: false,
      db: unavailableDb,
      discovery: { discover },
      env,
    });
    expect(lkg).toMatchObject({ health: 'degraded', source: 'lkg' });
    expect(lkg.databaseProviders[0]?.clientSecret).toBe(clientSecret);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('fails closed to environment break-glass when DB discovery fails without a prior LKG', async () => {
    const env = { ...(await baseEnv()), AUTH_SSO_PROVIDERS: 'google' };
    await seedPublished(env);
    const discover = vi.fn(async () => {
      throw new Error('OIDC_DISCOVERY_UNAVAILABLE');
    });

    const snapshot = await loadIdentityProviderStartupSnapshot({
      cache: false,
      db,
      discovery: { discover },
      env,
    });

    expect(snapshot).toMatchObject({
      databaseProviders: [],
      health: 'degraded',
      providerIds: ['google'],
      source: 'break_glass',
    });
    expect(discover).toHaveBeenCalledOnce();
  });

  it('preserves a good LKG when a newer revision has no matching secret', async () => {
    const env = await baseEnv();
    const { provider } = await seedPublished(env);
    const good = await loadSnapshot({ cache: false, db, env });
    const lkgPath = env.PLATFORM_OIDC_LKG_PATH!;
    const bytesBefore = await readFile(lkgPath);
    const identityBefore = (await readIdentityProviderLkg({
      env,
      secrets: PlatformSecretService.tryFromEnv(env)!,
    }))!.identityRevision;
    await publishRevision({
      providerId: provider.id,
      revision: 3,
      secretFingerprint: 'f'.repeat(64),
    });

    const fallback = await loadSnapshot({ cache: false, db, env });

    expect(good.source).toBe('database');
    expect(fallback).toMatchObject({ source: 'lkg' });
    expect(await readFile(lkgPath)).toEqual(bytesBefore);
    expect(
      (await readIdentityProviderLkg({
        env,
        secrets: PlatformSecretService.tryFromEnv(env)!,
      }))!.identityRevision,
    ).toBe(identityBefore);
  });

  it('preserves a good LKG when a newer revision fails secure discovery', async () => {
    const env = await baseEnv();
    const { provider, published } = await seedPublished(env);
    await loadSnapshot({ cache: false, db, env });
    const lkgPath = env.PLATFORM_OIDC_LKG_PATH!;
    const bytesBefore = await readFile(lkgPath);
    const identityBefore = (await readIdentityProviderLkg({
      env,
      secrets: PlatformSecretService.tryFromEnv(env)!,
    }))!.identityRevision;
    await publishRevision({
      issuer: 'https://unavailable.example.test',
      providerId: provider.id,
      revision: 3,
      secretFingerprint: published.secretFingerprint,
    });
    const discover = vi.fn(async (issuer: string) => {
      if (issuer === 'https://unavailable.example.test') {
        throw new Error('OIDC_DISCOVERY_UNAVAILABLE');
      }
      return discovery.discover(issuer);
    });

    const fallback = await loadIdentityProviderStartupSnapshot({
      cache: false,
      db,
      discovery: { discover },
      env,
    });

    expect(fallback).toMatchObject({ source: 'lkg' });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(await readFile(lkgPath)).toEqual(bytesBefore);
    expect(
      (await readIdentityProviderLkg({
        env,
        secrets: PlatformSecretService.tryFromEnv(env)!,
      }))!.identityRevision,
    ).toBe(identityBefore);
  });

  it('never writes a stale candidate when publication changes during validation', async () => {
    const env = await baseEnv();
    const { provider, published } = await seedPublished(env);
    await loadSnapshot({ cache: false, db, env });
    const lkgPath = env.PLATFORM_OIDC_LKG_PATH!;
    const bytesBefore = await readFile(lkgPath);
    let revision = 2;
    const discover = vi.fn(async (issuer: string) => {
      if (revision < 4) {
        revision++;
        await publishRevision({
          providerId: provider.id,
          revision,
          secretFingerprint: published.secretFingerprint,
        });
      }
      return discovery.discover(issuer);
    });

    const fallback = await loadIdentityProviderStartupSnapshot({
      cache: false,
      db,
      discovery: { discover },
      env,
    });

    expect(fallback).toMatchObject({ source: 'lkg' });
    expect(discover).toHaveBeenCalledTimes(3);
    expect(await readFile(lkgPath)).toEqual(bytesBefore);
  });

  it('keeps an environment provider authoritative over a conflicting DB provider', async () => {
    const env = { ...(await baseEnv()), AUTH_SSO_PROVIDERS: 'authentik' };
    const { provider } = await seedPublished(env, 'authentik');
    await seedPublished(env, 'work');
    await db
      .update(platformResourceRevisions)
      .set({ payload: { providerKey: 'authentik', unexpectedSecret: 'damaged-shadow-row' } })
      .where(eq(platformResourceRevisions.resourceId, provider.id));

    const snapshot = await loadSnapshot({ cache: false, db, env });
    expect(snapshot.providerIds).toEqual(['authentik', 'work']);
    expect(snapshot.databaseProviders).toHaveLength(1);
    expect(snapshot.databaseProviders[0]?.providerKey).toBe('work');
  });

  it('uses the immutable published key when the current draft key was renamed', async () => {
    const env = { ...(await baseEnv()), AUTH_SSO_PROVIDERS: 'corp' };
    const { provider } = await seedPublished(env, 'corp');
    await seedPublished(env, 'work');
    await db
      .update(platformIdentityProviders)
      .set({ providerKey: 'corp-new', status: 'draft' })
      .where(eq(platformIdentityProviders.id, provider.id));

    const snapshot = await loadSnapshot({ cache: false, db, env });
    expect(snapshot.providerIds).toEqual(['corp', 'work']);
    expect(snapshot.databaseProviders.map((item) => item.providerKey)).toEqual(['work']);
  });

  it.each([
    [
      'revision checksum',
      async (providerId: string) => {
        await db
          .update(platformResourceRevisions)
          .set({ checksum: 'f'.repeat(64) })
          .where(eq(platformResourceRevisions.resourceId, providerId));
      },
    ],
    [
      'independent revision secret fingerprint',
      async (providerId: string) => {
        await db
          .update(platformResourceRevisions)
          .set({ secretFingerprint: 'f'.repeat(64) })
          .where(eq(platformResourceRevisions.resourceId, providerId));
      },
    ],
  ])('rejects a published snapshot with a tampered %s', async (_label, tamper) => {
    const env = await baseEnv();
    const { provider } = await seedPublished(env);
    await tamper(provider.id);

    const snapshot = await loadSnapshot({ cache: false, db, env });
    expect(snapshot).toMatchObject({
      databaseProviders: [],
      health: 'degraded',
      source: 'break_glass',
    });
  });

  it('rejects a decrypted secret that does not match the exact published fingerprint', async () => {
    const env = await baseEnv();
    const { provider } = await seedPublished(env);
    const secretService = PlatformSecretService.tryFromEnv(env)!;
    const wrongCiphertext = await secretService.encrypt('wrong-secret');
    await db
      .update(platformIdentityProviderSecrets)
      .set({ ciphertext: wrongCiphertext })
      .where(eq(platformIdentityProviderSecrets.providerId, provider.id));

    const snapshot = await loadSnapshot({ cache: false, db, env });
    expect(snapshot).toMatchObject({
      databaseProviders: [],
      health: 'degraded',
      source: 'break_glass',
    });
  });

  it('uses LKG when DB becomes unavailable and never substitutes a wrong new secret', async () => {
    const env = await baseEnv();
    const { clientSecret } = await seedPublished(env);
    await loadSnapshot({ cache: false, db, env });
    const unavailableDb = new Proxy({} as LobeChatDatabase, {
      get: () => {
        throw new Error('DATABASE_UNAVAILABLE');
      },
    });

    const fallback = await loadSnapshot({
      cache: false,
      db: unavailableDb,
      env,
    });
    expect(fallback).toMatchObject({ health: 'degraded', source: 'lkg' });
    expect(fallback.databaseProviders[0]?.clientSecret).toBe(clientSecret);
  });

  it('recomputes LKG identity and generation after an environment override filters a provider', async () => {
    const env = await baseEnv();
    await seedPublished(env, 'corp');
    await seedPublished(env, 'work');
    const full = await loadSnapshot({ cache: false, db, env });
    const secretService = PlatformSecretService.tryFromEnv(env)!;
    const lkg = await readIdentityProviderLkg({ env, secrets: secretService });
    const retained = lkg!.providers.filter((provider) => provider.payload.providerKey === 'work');
    const unavailableDb = new Proxy({} as LobeChatDatabase, {
      get: () => {
        throw new Error('DATABASE_UNAVAILABLE');
      },
    });

    const fallback = await loadSnapshot({
      cache: false,
      db: unavailableDb,
      env: { ...env, AUTH_SSO_PROVIDERS: 'corp' },
    });

    expect(fallback.databaseProviders.map((provider) => provider.providerKey)).toEqual(['work']);
    expect(fallback.identityRevision).toBe(identityProviderLkgIdentity(retained));
    expect(fallback.generation).toBe(identityProviderLkgGeneration(retained));
    expect(fallback.identityRevision).not.toBe(full.identityRevision);
  });

  it('falls back only to break-glass providers when both DB and LKG are unavailable', async () => {
    const env = { ...(await baseEnv()), AUTH_SSO_PROVIDERS: 'google' };
    const unavailableDb = new Proxy({} as LobeChatDatabase, {
      get: () => {
        throw new Error('DATABASE_UNAVAILABLE');
      },
    });

    const fallback = await loadSnapshot({
      cache: false,
      db: unavailableDb,
      env,
    });
    expect(fallback).toMatchObject({
      databaseProviders: [],
      health: 'degraded',
      providerIds: ['google'],
      source: 'break_glass',
    });
  });
});
