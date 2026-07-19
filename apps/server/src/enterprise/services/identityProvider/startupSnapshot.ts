import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { checksumPayload } from '@/database/models/platform';
import {
  platformIdentityProviderSecrets,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type { RuntimeIdentityProvider } from '@/libs/better-auth/sso/platformIdentityProvider';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { PlatformSecretService } from '../../security/secret';
import {
  identityProviderLkgGeneration,
  identityProviderLkgIdentity,
  type IdentityProviderLkgPayload,
  readIdentityProviderLkg,
  writeIdentityProviderLkg,
} from './lkg';
import { parsePublishedIdentityProviderPayload } from './publicationService';
import {
  commitIdentityProviderStartupFailure,
  commitIdentityProviderStartupSnapshot,
  getIdentityProviderStartupArtifactHealth,
  type IdentityProviderStartupHealth,
  type IdentityProviderStartupSnapshot,
  markIdentityProviderStartupLoading,
  resetIdentityProviderStartupArtifactForTest,
} from './startupArtifact';

export type {
  IdentityProviderStartupHealth,
  IdentityProviderStartupSnapshot,
  IdentityProviderStartupSource,
} from './startupArtifact';

interface LoadOptions {
  cache?: boolean;
  db?: LobeChatDatabase;
  env?: Record<string, string | undefined>;
}

const parseEnvironmentProviderIds = (env: Record<string, string | undefined>): string[] => [
  ...new Set(
    (env.AUTH_SSO_PROVIDERS ?? '')
      .split(',')
      .map((provider) => provider.trim().toLowerCase())
      .filter(Boolean),
  ),
];

const errorCategory = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('LKG_STALE')) return 'lkg_stale';
  if (message.includes('SIGNATURE')) return 'lkg_signature_invalid';
  if (message.includes('PERMISSION') || message.includes('OWNER')) return 'lkg_permissions_invalid';
  if (message.includes('SECRET')) return 'secret_unavailable';
  return 'startup_snapshot_unavailable';
};

const fingerprint = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const identityRevision = (
  providers: Array<{
    checksum: string;
    generation: string;
    payload: { providerKey: string; secretFingerprint: string };
    providerId: string;
    revision: number;
    secretFingerprint: string;
  }>,
): string => identityProviderLkgIdentity(providers);

const publishedProviderKey = (value: unknown): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const providerKey = (value as Record<string, unknown>).providerKey;
  return typeof providerKey === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(providerKey)
    ? providerKey
    : null;
};

type DatabaseExecutor = LobeChatDatabase | Transaction;

const loadDatabasePayload = async (input: {
  db: DatabaseExecutor;
  environmentProviderIds: Set<string>;
}) => {
  const rows = await input.db
    .select({
      checksum: platformResourceRevisions.checksum,
      id: platformResourceRevisions.id,
      payload: platformResourceRevisions.payload,
      publishedAt: platformResourceRevisions.publishedAt,
      resourceId: platformResourceRevisions.resourceId,
      revision: platformResourceRevisions.revision,
      secretFingerprint: platformResourceRevisions.secretFingerprint,
    })
    .from(platformResourceRevisions)
    .where(
      and(
        eq(platformResourceRevisions.resourceType, 'oidc'),
        eq(platformResourceRevisions.status, 'published'),
      ),
    )
    .orderBy(desc(platformResourceRevisions.revision));
  const latest = new Map<
    string,
    {
      checksum: string;
      generation: string;
      payload: NonNullable<ReturnType<typeof parsePublishedIdentityProviderPayload>>;
      providerId: string;
      revision: number;
      secretFingerprint: string;
    }
  >();
  const seenResourceIds = new Set<string>();
  for (const row of rows) {
    if (seenResourceIds.has(row.resourceId)) continue;
    seenResourceIds.add(row.resourceId);
    // An environment provider is the break-glass authority. Skip its database
    // counterpart before strict snapshot parsing so a damaged shadow row cannot
    // prevent the explicitly configured provider from starting.
    const providerKey = publishedProviderKey(row.payload);
    if (providerKey && input.environmentProviderIds.has(providerKey.toLowerCase())) {
      continue;
    }
    const payload = parsePublishedIdentityProviderPayload(row.payload);
    if (
      !payload ||
      !row.publishedAt ||
      row.checksum !== checksumPayload(row.payload) ||
      row.secretFingerprint !== payload.secretFingerprint
    ) {
      throw new Error('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
    }
    latest.set(row.resourceId, {
      checksum: row.checksum,
      generation: `${row.publishedAt.toISOString()}:${row.id}`,
      payload,
      providerId: row.resourceId,
      revision: row.revision,
      secretFingerprint: row.secretFingerprint,
    });
  }
  const selected = [...latest.values()];
  if (new Set(selected.map((row) => row.payload.providerKey)).size !== selected.length) {
    throw new Error('PLATFORM_IDENTITY_PROVIDER_DUPLICATE_KEY');
  }
  if (selected.length === 0) return [];
  const providerIds = selected.map((provider) => provider.providerId);
  const secrets = await input.db
    .select({
      ciphertext: platformIdentityProviderSecrets.ciphertext,
      fingerprint: platformIdentityProviderSecrets.fingerprint,
      providerId: platformIdentityProviderSecrets.providerId,
    })
    .from(platformIdentityProviderSecrets)
    .where(
      and(
        inArray(platformIdentityProviderSecrets.providerId, providerIds),
        isNull(platformIdentityProviderSecrets.revokedAt),
      ),
    );
  return selected.map((provider) => {
    const secret = secrets.find(
      (candidate) =>
        candidate.providerId === provider.providerId &&
        candidate.fingerprint === provider.payload.secretFingerprint,
    );
    if (!secret) throw new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE');
    if (secret.fingerprint !== provider.secretFingerprint) {
      throw new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_FINGERPRINT_MISMATCH');
    }
    return { ...provider, secretCiphertext: secret.ciphertext };
  });
};

const snapshotGeneration = (rows: Awaited<ReturnType<typeof loadDatabasePayload>>): string =>
  identityProviderLkgGeneration(rows);

const materializeProviders = async (
  rows: Awaited<ReturnType<typeof loadDatabasePayload>>,
  secrets: PlatformSecretService,
): Promise<RuntimeIdentityProvider[]> =>
  Promise.all(
    rows.map(async (row) => {
      const clientSecret = await secrets.decrypt(row.secretCiphertext);
      if (fingerprint(clientSecret) !== row.payload.secretFingerprint) {
        throw new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_FINGERPRINT_MISMATCH');
      }
      return { ...row.payload, clientSecret, revision: row.revision };
    }),
  );

const toLkgPayload = (
  rows: Awaited<ReturnType<typeof loadDatabasePayload>>,
): IdentityProviderLkgPayload => ({
  createdAt: new Date().toISOString(),
  domain: 'platform-oidc-lkg',
  generation: snapshotGeneration(rows),
  identityRevision: identityRevision(rows),
  providers: rows.map((row) => ({
    checksum: row.checksum,
    generation: row.generation,
    payload: row.payload as unknown as Record<string, unknown>,
    providerId: row.providerId,
    revision: row.revision,
    secretCiphertext: row.secretCiphertext,
    secretFingerprint: row.secretFingerprint,
  })),
  version: 1,
});

const fromLkgPayload = (payload: IdentityProviderLkgPayload, environmentProviderIds: Set<string>) =>
  payload.providers.flatMap((provider) => {
    const rawProviderKey = provider.payload.providerKey;
    if (
      typeof rawProviderKey === 'string' &&
      environmentProviderIds.has(rawProviderKey.toLowerCase())
    ) {
      return [];
    }
    const parsed = parsePublishedIdentityProviderPayload(provider.payload);
    if (
      !parsed ||
      checksumPayload(provider.payload) !== provider.checksum ||
      parsed.secretFingerprint !== provider.secretFingerprint
    ) {
      throw new Error('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
    }
    return [
      {
        checksum: provider.checksum,
        generation: provider.generation,
        payload: parsed,
        providerId: provider.providerId,
        revision: provider.revision,
        secretCiphertext: provider.secretCiphertext,
        secretFingerprint: provider.secretFingerprint,
      },
    ];
  });

const loadDatabase = async (): Promise<LobeChatDatabase> => {
  const database = await import('@lobechat/database');
  return database.serverDB;
};

const LKG_ADVISORY_LOCK_NAMESPACE = 1_278_874_436;
const LKG_ADVISORY_LOCK_RESOURCE = 1_223_953_479;

export const acquireIdentityProviderLkgAdvisoryLock = async (
  db: DatabaseExecutor,
): Promise<void> => {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(${LKG_ADVISORY_LOCK_NAMESPACE}, ${LKG_ADVISORY_LOCK_RESOURCE})`,
  );
};

export const withIdentityProviderLkgAdvisoryLock = async <T>(
  db: LobeChatDatabase,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  db.transaction(async (tx) => {
    await acquireIdentityProviderLkgAdvisoryLock(tx);
    return work(tx);
  });

const loadUncached = async (options: LoadOptions): Promise<IdentityProviderStartupSnapshot> => {
  const env = options.env ?? process.env;
  const environmentProviderIds = parseEnvironmentProviderIds(env);
  const loadedAt = new Date();
  if (!parseEnterpriseFeatureFlags(env).ENABLE_DATABASE_OIDC) {
    return {
      databaseProviders: [],
      generation: null,
      health: 'healthy',
      identityRevision: null,
      lastError: null,
      loadedAt,
      providerIds: environmentProviderIds,
      source: 'environment',
    };
  }

  const secrets = PlatformSecretService.tryFromEnv(env);
  let databaseError: unknown = new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE');
  if (secrets) {
    try {
      const db = options.db ?? (await loadDatabase());
      const loaded = await withIdentityProviderLkgAdvisoryLock(db, async (tx) => {
        const rows = await loadDatabasePayload({
          db: tx,
          environmentProviderIds: new Set(environmentProviderIds),
        });
        const databaseProviders = await materializeProviders(rows, secrets);
        const revision = identityRevision(rows);
        const generation = snapshotGeneration(rows);
        let lastError: string | null = null;
        try {
          const writeResult = await writeIdentityProviderLkg({
            env,
            payload: toLkgPayload(rows),
            secrets,
          });
          if (writeResult !== 'written' && writeResult !== 'unchanged') {
            lastError = `lkg_write_${writeResult}`;
          }
        } catch (error) {
          console.error('[identityProviderStartup] LKG write unavailable', {
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          });
          lastError = 'lkg_write_unavailable';
        }
        return { databaseProviders, generation, lastError, revision };
      });
      return {
        databaseProviders: loaded.databaseProviders,
        generation: loaded.generation,
        health: loaded.lastError ? 'degraded' : 'healthy',
        identityRevision: loaded.revision,
        lastError: loaded.lastError,
        loadedAt,
        providerIds: [
          ...environmentProviderIds,
          ...loaded.databaseProviders.map((provider) => provider.providerKey),
        ],
        source: 'database',
      };
    } catch (error) {
      databaseError = error;
      console.error('[identityProviderStartup] critical database snapshot failure', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    try {
      const lkg = await readIdentityProviderLkg({ env, secrets });
      if (lkg) {
        const rows = fromLkgPayload(lkg, new Set(environmentProviderIds));
        const databaseProviders = await materializeProviders(rows, secrets);
        return {
          databaseProviders,
          generation: snapshotGeneration(rows),
          health: 'degraded',
          identityRevision: identityRevision(rows),
          lastError: errorCategory(databaseError),
          loadedAt,
          providerIds: [
            ...environmentProviderIds,
            ...databaseProviders
              .map((provider) => provider.providerKey)
              .filter((provider) => !environmentProviderIds.includes(provider)),
          ],
          source: 'lkg',
        };
      }
    } catch (error) {
      databaseError = error;
      console.error('[identityProviderStartup] critical LKG snapshot failure', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  return {
    databaseProviders: [],
    generation: null,
    health: 'degraded',
    identityRevision: null,
    lastError: errorCategory(databaseError),
    loadedAt,
    providerIds: environmentProviderIds,
    source: 'break_glass',
  };
};

let startupPromise: Promise<IdentityProviderStartupSnapshot> | null = null;

export const loadIdentityProviderStartupSnapshot = async (
  options: LoadOptions = {},
): Promise<IdentityProviderStartupSnapshot> => {
  if (options.cache === false) return loadUncached(options);
  markIdentityProviderStartupLoading();
  startupPromise ??= loadUncached(options)
    .then((snapshot) => {
      commitIdentityProviderStartupSnapshot(snapshot);
      return snapshot;
    })
    .catch((error) => {
      console.error('[identityProviderStartup] initialization failed closed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
      return commitIdentityProviderStartupFailure(options.env);
    });
  return startupPromise;
};

export const getIdentityProviderStartupHealth = (): IdentityProviderStartupHealth | null =>
  getIdentityProviderStartupArtifactHealth();

export const resetIdentityProviderStartupSnapshotForTest = (): void => {
  startupPromise = null;
  resetIdentityProviderStartupArtifactForTest();
};
