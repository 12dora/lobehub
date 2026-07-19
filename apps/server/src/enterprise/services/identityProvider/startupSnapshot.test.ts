// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import type { PublishedIdentityProviderPayload } from './publicationService';
import {
  loadIdentityProviderStartupSnapshot,
  resetIdentityProviderStartupSnapshotForTest,
} from './startupSnapshot';

const db: LobeChatDatabase = await getTestDB();
const masterKey = Buffer.alloc(32, 88).toString('base64');
const directories: string[] = [];

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

const payload = (providerKey = 'work'): PublishedIdentityProviderPayload => ({
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
  type: 'authentik',
  usePkce: true,
});

const seedPublished = async (env: Record<string, string | undefined>, providerKey = 'work') => {
  const clientSecret = 'fake-startup-client-secret';
  const secretFingerprint = createHash('sha256').update(clientSecret).digest('hex');
  const published = { ...payload(providerKey), secretFingerprint };
  const secretService = PlatformSecretService.tryFromEnv(env)!;
  const ciphertext = await secretService.encrypt(clientSecret);
  const [provider] = await db
    .insert(platformIdentityProviders)
    .values({
      activationRevision: 2,
      clientId: published.clientId,
      displayName: published.displayName,
      enabled: true,
      issuer: published.issuer,
      providerKey,
      revision: 2,
      secretFingerprint,
      secretRef: `kms://platform-identity-providers/${providerKey}/secret`,
      secretUpdatedAt: new Date(),
      status: 'pending_restart',
      type: published.type,
    })
    .returning();
  await db.insert(platformIdentityProviderSecrets).values({
    ciphertext,
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
  return { clientSecret, provider };
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
  it('has a flag-off zero DB/LKG path', async () => {
    const snapshot = await loadIdentityProviderStartupSnapshot({
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

  it('loads a complete DB snapshot once, verifies the secret, and marks it active', async () => {
    const env = await baseEnv();
    const { clientSecret, provider } = await seedPublished(env);
    const first = await loadIdentityProviderStartupSnapshot({ db, env });
    const second = await loadIdentityProviderStartupSnapshot({ db, env });

    expect(second).toBe(first);
    expect(first).toMatchObject({ health: 'healthy', providerIds: ['work'], source: 'database' });
    expect(first.databaseProviders[0]).toMatchObject({
      clientSecret,
      providerKey: 'work',
      revision: 2,
    });
    const [activated] = await db.select().from(platformIdentityProviders);
    expect(activated).toMatchObject({ id: provider.id, status: 'active' });
  });

  it('keeps an environment provider authoritative over a conflicting DB provider', async () => {
    const env = { ...(await baseEnv()), AUTH_SSO_PROVIDERS: 'authentik' };
    const { provider } = await seedPublished(env, 'authentik');
    await db
      .update(platformResourceRevisions)
      .set({ payload: { providerKey: 'authentik', unexpectedSecret: 'damaged-shadow-row' } })
      .where(eq(platformResourceRevisions.resourceId, provider.id));

    const snapshot = await loadIdentityProviderStartupSnapshot({ cache: false, db, env });
    expect(snapshot.providerIds).toEqual(['authentik']);
    expect(snapshot.databaseProviders).toEqual([]);
  });

  it('uses LKG when DB becomes unavailable and never substitutes a wrong new secret', async () => {
    const env = await baseEnv();
    const { clientSecret } = await seedPublished(env);
    await loadIdentityProviderStartupSnapshot({ cache: false, db, env });
    const unavailableDb = new Proxy({} as LobeChatDatabase, {
      get: () => {
        throw new Error('DATABASE_UNAVAILABLE');
      },
    });

    const fallback = await loadIdentityProviderStartupSnapshot({
      cache: false,
      db: unavailableDb,
      env,
    });
    expect(fallback).toMatchObject({ health: 'degraded', source: 'lkg' });
    expect(fallback.databaseProviders[0]?.clientSecret).toBe(clientSecret);
  });

  it('falls back only to break-glass providers when both DB and LKG are unavailable', async () => {
    const env = { ...(await baseEnv()), AUTH_SSO_PROVIDERS: 'google' };
    const unavailableDb = new Proxy({} as LobeChatDatabase, {
      get: () => {
        throw new Error('DATABASE_UNAVAILABLE');
      },
    });

    const fallback = await loadIdentityProviderStartupSnapshot({
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
