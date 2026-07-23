import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { checksumPayload } from '@/database/models/platform';
import { withIdentityProviderPublishedRevisionLock } from '@/database/models/platform/identityProviderPublishedRevisionLock';
import {
  platformIdentityProviderSecrets,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type { RuntimeIdentityProvider } from '@/libs/better-auth/sso/platformIdentityProvider';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretService } from '../../security/secret';
import { IdentityProviderDiscoveryValidator } from './discoveryValidator';
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
  discovery?: Pick<IdentityProviderDiscoveryValidator, 'discover'>;
  env?: Record<string, string | undefined>;
  testHooks?: {
    afterCanonicalRecheck?: () => Promise<void>;
  };
}

export const parseEnvironmentIdentityProviderIds = (
  env: Record<string, string | undefined>,
): string[] => [
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

export const loadPublishedIdentityProviderSelection = async (input: {
  db: DatabaseExecutor;
  environmentProviderIds: Set<string>;
}) => {
  // DISTINCT ON keeps only the highest revision per provider at the database
  // (avoids loading full published revision history into memory at startup).
  const rows = await input.db
    .selectDistinctOn([platformResourceRevisions.resourceId], {
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
    .orderBy(
      platformResourceRevisions.resourceId,
      desc(platformResourceRevisions.revision),
      desc(platformResourceRevisions.publishedAt),
    );
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
  /** Tombstones advance generation/identity so LKG cannot resurrect a disabled provider. */
  const tombstoneGenerations: string[] = [];
  const environmentShadowed: Array<{ providerId: string; providerKey: string }> = [];
  for (const row of rows) {
    // An environment provider is the break-glass authority. Skip its database
    // counterpart before strict snapshot parsing so a damaged shadow row cannot
    // prevent the explicitly configured provider from starting.
    const providerKey = publishedProviderKey(row.payload);
    if (providerKey && input.environmentProviderIds.has(providerKey.toLowerCase())) {
      environmentShadowed.push({ providerId: row.resourceId, providerKey });
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
    const generation = `${row.publishedAt.toISOString()}:${row.id}`;
    // Signed tombstone: do not materialize for login, but honor in generation.
    if (payload.enabled === false) {
      tombstoneGenerations.push(generation);
      continue;
    }
    latest.set(row.resourceId, {
      checksum: row.checksum,
      generation,
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
  return { environmentShadowed, selected, tombstoneGenerations };
};

export const loadCanonicalPublishedIdentityProviders = async (input: {
  db: DatabaseExecutor;
  environmentProviderIds: Set<string>;
}) => (await loadPublishedIdentityProviderSelection(input)).selected;

type DatabaseProviderRow = {
  checksum: string;
  generation: string;
  payload: NonNullable<ReturnType<typeof parsePublishedIdentityProviderPayload>>;
  providerId: string;
  revision: number;
  secretCiphertext: string;
  secretFingerprint: string;
};

type DatabasePayload = {
  rows: DatabaseProviderRow[];
  /** Generations from signed tombstones (enabled:false) so LKG advances on revoke. */
  tombstoneGenerations: string[];
};

const loadDatabasePayload = async (input: {
  db: DatabaseExecutor;
  environmentProviderIds: Set<string>;
}): Promise<DatabasePayload> => {
  const selection = await loadPublishedIdentityProviderSelection(input);
  const selected = selection.selected;
  if (selected.length === 0) {
    return { rows: [], tombstoneGenerations: selection.tombstoneGenerations };
  }
  // Exact (providerId, fingerprint) pairs only — filter after query so unrelated
  // historical secrets that share only one of the two keys are discarded.
  const pairKeySet = new Set(
    selected.map((provider) => `${provider.providerId}:${provider.payload.secretFingerprint}`),
  );
  const secrets = await input.db
    .select({
      ciphertext: platformIdentityProviderSecrets.ciphertext,
      fingerprint: platformIdentityProviderSecrets.fingerprint,
      providerId: platformIdentityProviderSecrets.providerId,
    })
    .from(platformIdentityProviderSecrets)
    .where(
      and(
        inArray(platformIdentityProviderSecrets.providerId, [
          ...new Set(selected.map((provider) => provider.providerId)),
        ]),
        inArray(platformIdentityProviderSecrets.fingerprint, [
          ...new Set(selected.map((provider) => provider.payload.secretFingerprint)),
        ]),
        isNull(platformIdentityProviderSecrets.revokedAt),
      ),
    );
  const secretsByKey = new Map(
    secrets
      .filter((secret) => pairKeySet.has(`${secret.providerId}:${secret.fingerprint}`))
      .map((secret) => [`${secret.providerId}:${secret.fingerprint}`, secret] as const),
  );
  const rows = selected.map((provider) => {
    const secret = secretsByKey.get(`${provider.providerId}:${provider.payload.secretFingerprint}`);
    if (!secret) throw new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE');
    if (secret.fingerprint !== provider.secretFingerprint) {
      throw new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_FINGERPRINT_MISMATCH');
    }
    return { ...provider, secretCiphertext: secret.ciphertext };
  });
  return { rows, tombstoneGenerations: selection.tombstoneGenerations };
};

const snapshotGeneration = (payload: DatabasePayload): string =>
  identityProviderLkgGeneration([
    ...payload.rows,
    ...payload.tombstoneGenerations.map((generation) => ({ generation })),
  ]);

type MaterializedIdentityProvider = Omit<RuntimeIdentityProvider, 'oidcMetadata'>;

const materializeProviders = async (
  rows: DatabaseProviderRow[],
  secrets: PlatformSecretService,
): Promise<MaterializedIdentityProvider[]> =>
  Promise.all(
    rows.map(async (row) => {
      const clientSecret = await secrets.decrypt(row.secretCiphertext);
      if (fingerprint(clientSecret) !== row.payload.secretFingerprint) {
        throw new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_FINGERPRINT_MISMATCH');
      }
      return { ...row.payload, clientSecret, revision: row.revision };
    }),
  );

const enrichRuntimeProviders = async (
  providers: MaterializedIdentityProvider[],
  discovery: Pick<IdentityProviderDiscoveryValidator, 'discover'>,
): Promise<RuntimeIdentityProvider[]> =>
  Promise.all(
    providers.map(async (provider) => ({
      ...provider,
      oidcMetadata: await discovery.discover(provider.issuer),
    })),
  );

const databasePayloadMatches = (candidate: DatabasePayload, current: DatabasePayload): boolean =>
  snapshotGeneration(candidate) === snapshotGeneration(current) &&
  identityRevision(candidate.rows) === identityRevision(current.rows) &&
  candidate.rows.length === current.rows.length &&
  candidate.tombstoneGenerations.length === current.tombstoneGenerations.length &&
  candidate.tombstoneGenerations.every(
    (generation, index) => generation === current.tombstoneGenerations[index],
  ) &&
  candidate.rows.every((row, index) => {
    const currentRow = current.rows[index];
    return (
      currentRow !== undefined &&
      row.checksum === currentRow.checksum &&
      row.generation === currentRow.generation &&
      row.providerId === currentRow.providerId &&
      row.revision === currentRow.revision &&
      row.secretCiphertext === currentRow.secretCiphertext &&
      row.secretFingerprint === currentRow.secretFingerprint
    );
  });

const toLkgPayload = (payload: DatabasePayload): IdentityProviderLkgPayload => ({
  createdAt: new Date().toISOString(),
  domain: 'platform-oidc-lkg',
  generation: snapshotGeneration(payload),
  identityRevision: identityRevision(payload.rows),
  providers: payload.rows.map((row) => ({
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

const fromLkgPayload = (
  payload: IdentityProviderLkgPayload,
  environmentProviderIds: Set<string>,
): DatabasePayload => ({
  rows: payload.providers.flatMap((provider) => {
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
      parsed.enabled === false ||
      checksumPayload(provider.payload) !== provider.checksum ||
      parsed.secretFingerprint !== provider.secretFingerprint
    ) {
      // Skip tombstones and invalid rows; LKG must not resurrect disabled providers.
      if (parsed?.enabled === false) return [];
      if (!parsed) throw new Error('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
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
  }),
  tombstoneGenerations: [],
});

const loadDatabase = async (): Promise<LobeChatDatabase> => {
  const database = await import('@lobechat/database');
  return database.serverDB;
};

const loadUncached = async (options: LoadOptions): Promise<IdentityProviderStartupSnapshot> => {
  const env = options.env ?? process.env;
  const environmentProviderIds = parseEnvironmentIdentityProviderIds(env);
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
  const discovery =
    options.discovery ??
    new IdentityProviderDiscoveryValidator(new SafeOutboundHttpClient({ mode: 'public-only' }));
  let databaseError: unknown = new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE');
  if (secrets) {
    try {
      const db = options.db ?? (await loadDatabase());
      const environmentProviderIdSet = new Set(environmentProviderIds);
      for (let attempt = 0; attempt < 2; attempt++) {
        const payload = await loadDatabasePayload({
          db,
          environmentProviderIds: environmentProviderIdSet,
        });
        // Secret integrity and every remote endpoint are validated before the
        // candidate is allowed to replace the last-known-good snapshot.
        const databaseProviders = await enrichRuntimeProviders(
          await materializeProviders(payload.rows, secrets),
          discovery,
        );
        const committed = await withIdentityProviderPublishedRevisionLock(db, async (tx) => {
          const currentPayload = await loadDatabasePayload({
            db: tx,
            environmentProviderIds: environmentProviderIdSet,
          });
          if (!databasePayloadMatches(payload, currentPayload)) return null;
          await options.testHooks?.afterCanonicalRecheck?.();

          let lastError: string | null = null;
          try {
            const writeResult = await writeIdentityProviderLkg({
              env,
              payload: toLkgPayload(currentPayload),
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
          return {
            generation: snapshotGeneration(currentPayload),
            lastError,
            revision: identityRevision(currentPayload.rows),
          };
        });
        if (!committed) {
          if (attempt === 0) continue;
          throw new Error('PLATFORM_IDENTITY_PROVIDER_SNAPSHOT_CHANGED');
        }
        return {
          databaseProviders,
          generation: committed.generation,
          health: committed.lastError ? 'degraded' : 'healthy',
          identityRevision: committed.revision,
          lastError: committed.lastError,
          loadedAt,
          providerIds: [
            ...environmentProviderIds,
            ...databaseProviders.map((provider) => provider.providerKey),
          ],
          source: 'database',
        };
      }
      throw new Error('PLATFORM_IDENTITY_PROVIDER_SNAPSHOT_CHANGED');
    } catch (error) {
      databaseError = error;
      console.error('[identityProviderStartup] critical database snapshot failure', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    try {
      const lkg = await readIdentityProviderLkg({ env, secrets });
      if (lkg) {
        const payload = fromLkgPayload(lkg, new Set(environmentProviderIds));
        const databaseProviders = await enrichRuntimeProviders(
          await materializeProviders(payload.rows, secrets),
          discovery,
        );
        return {
          databaseProviders,
          generation: snapshotGeneration(payload),
          health: 'degraded',
          identityRevision: identityRevision(payload.rows),
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

export const resetIdentityProviderStartupSnapshotForTest = (): void => {
  startupPromise = null;
  resetIdentityProviderStartupArtifactForTest();
};
