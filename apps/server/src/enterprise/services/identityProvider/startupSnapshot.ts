import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { checksumPayload } from '@/database/models/platform';
import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import type { RuntimeIdentityProvider } from '@/libs/better-auth/sso/platformIdentityProvider';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { PlatformSecretService } from '../../security/secret';
import {
  emptyIdentityProviderLkgGeneration,
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
    payload: { providerKey: string; secretFingerprint: string };
    providerId: string;
    revision: number;
    secretFingerprint: string;
  }>,
): string => identityProviderLkgIdentity(providers);

const loadDatabasePayload = async (input: {
  db: LobeChatDatabase;
  environmentProviderIds: Set<string>;
}) => {
  const rows = await input.db
    .select({
      checksum: platformResourceRevisions.checksum,
      id: platformResourceRevisions.id,
      payload: platformResourceRevisions.payload,
      publishedAt: platformResourceRevisions.publishedAt,
      providerKey: platformIdentityProviders.providerKey,
      resourceId: platformResourceRevisions.resourceId,
      revision: platformResourceRevisions.revision,
      secretFingerprint: platformResourceRevisions.secretFingerprint,
    })
    .from(platformResourceRevisions)
    .leftJoin(
      platformIdentityProviders,
      eq(platformIdentityProviders.id, platformResourceRevisions.resourceId),
    )
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
    if (row.providerKey && input.environmentProviderIds.has(row.providerKey.toLowerCase())) {
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
  rows.reduce(
    (latest, row) => (row.generation > latest ? row.generation : latest),
    emptyIdentityProviderLkgGeneration,
  );

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
        generation: payload.generation,
        payload: parsed,
        providerId: provider.providerId,
        revision: provider.revision,
        secretCiphertext: provider.secretCiphertext,
        secretFingerprint: provider.secretFingerprint,
      },
    ];
  });

const activateLoadedRevisions = async (
  db: LobeChatDatabase,
  providers: RuntimeIdentityProvider[],
): Promise<void> => {
  for (const provider of providers) {
    await db
      .update(platformIdentityProviders)
      .set({ status: 'active', updatedAt: new Date() })
      .where(
        and(
          eq(platformIdentityProviders.providerKey, provider.providerKey),
          eq(platformIdentityProviders.activationRevision, provider.revision),
          eq(platformIdentityProviders.status, 'pending_restart'),
        ),
      );
  }
};

const loadDatabase = async (): Promise<LobeChatDatabase> => {
  const database = await import('@lobechat/database');
  return database.serverDB;
};

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
      const rows = await loadDatabasePayload({
        db,
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
      try {
        await activateLoadedRevisions(db, databaseProviders);
      } catch (error) {
        console.error('[identityProviderStartup] activation status update unavailable', {
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        });
        lastError = lastError ?? 'activation_status_update_unavailable';
      }
      return {
        databaseProviders,
        generation,
        health: lastError ? 'degraded' : 'healthy',
        identityRevision: revision,
        lastError,
        loadedAt,
        providerIds: [
          ...environmentProviderIds,
          ...databaseProviders.map((provider) => provider.providerKey),
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
        const databaseProviders = await materializeProviders(
          fromLkgPayload(lkg, new Set(environmentProviderIds)),
          secrets,
        );
        return {
          databaseProviders,
          generation: lkg.generation,
          health: 'degraded',
          identityRevision: lkg.identityRevision,
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
