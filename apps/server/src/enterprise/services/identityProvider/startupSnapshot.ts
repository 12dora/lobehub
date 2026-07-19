import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

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
  type IdentityProviderLkgPayload,
  readIdentityProviderLkg,
  writeIdentityProviderLkg,
} from './lkg';
import { parsePublishedIdentityProviderPayload } from './publicationService';

export type IdentityProviderStartupSource = 'break_glass' | 'database' | 'environment' | 'lkg';

export interface IdentityProviderStartupHealth {
  health: 'degraded' | 'healthy';
  identityRevision: string | null;
  lastError: string | null;
  loadedAt: Date;
  source: IdentityProviderStartupSource;
}

export interface IdentityProviderStartupSnapshot extends IdentityProviderStartupHealth {
  databaseProviders: RuntimeIdentityProvider[];
  providerIds: string[];
}

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
  providers: Array<{ payload: { providerKey: string }; revision: number }>,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        providers
          .map((provider) => ({
            providerKey: provider.payload.providerKey,
            revision: provider.revision,
          }))
          .sort((left, right) => left.providerKey.localeCompare(right.providerKey)),
      ),
    )
    .digest('hex');

const loadDatabasePayload = async (input: {
  db: LobeChatDatabase;
  environmentProviderIds: Set<string>;
}) => {
  const rows = await input.db
    .select({
      payload: platformResourceRevisions.payload,
      resourceId: platformResourceRevisions.resourceId,
      revision: platformResourceRevisions.revision,
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
    { payload: ReturnType<typeof parsePublishedIdentityProviderPayload>; revision: number }
  >();
  for (const row of rows) {
    if (latest.has(row.resourceId)) continue;
    // An environment provider is the break-glass authority. Skip its database
    // counterpart before strict snapshot parsing so a damaged shadow row cannot
    // prevent the explicitly configured provider from starting.
    const rawProviderKey =
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>).providerKey
        : undefined;
    if (
      typeof rawProviderKey === 'string' &&
      input.environmentProviderIds.has(rawProviderKey.toLowerCase())
    ) {
      latest.set(row.resourceId, {
        payload: row.payload as unknown as ReturnType<typeof parsePublishedIdentityProviderPayload>,
        revision: row.revision,
      });
      continue;
    }
    const payload = parsePublishedIdentityProviderPayload(row.payload);
    if (!payload) throw new Error('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
    latest.set(row.resourceId, { payload, revision: row.revision });
  }
  const selected = [...latest.entries()]
    .filter(([, row]) => row.payload !== null)
    .map(([providerId, row]) => ({ providerId, payload: row.payload!, revision: row.revision }));
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
    return { ...provider, secretCiphertext: secret.ciphertext };
  });
};

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
  identityRevision: identityRevision(rows),
  providers: rows.map((row) => ({
    payload: row.payload as unknown as Record<string, unknown>,
    revision: row.revision,
    secretCiphertext: row.secretCiphertext,
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
    if (!parsed) throw new Error('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
    return [
      {
        payload: parsed,
        providerId: '',
        revision: provider.revision,
        secretCiphertext: provider.secretCiphertext,
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
      let lastError: string | null = null;
      try {
        await writeIdentityProviderLkg({ env, payload: toLkgPayload(rows), secrets });
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
    health: 'degraded',
    identityRevision: null,
    lastError: errorCategory(databaseError),
    loadedAt,
    providerIds: environmentProviderIds,
    source: 'break_glass',
  };
};

let startupPromise: Promise<IdentityProviderStartupSnapshot> | null = null;
let startupHealth: IdentityProviderStartupHealth | null = null;

export const loadIdentityProviderStartupSnapshot = async (
  options: LoadOptions = {},
): Promise<IdentityProviderStartupSnapshot> => {
  if (options.cache === false) return loadUncached(options);
  startupPromise ??= loadUncached(options).then((snapshot) => {
    startupHealth = {
      health: snapshot.health,
      identityRevision: snapshot.identityRevision,
      lastError: snapshot.lastError,
      loadedAt: snapshot.loadedAt,
      source: snapshot.source,
    };
    return snapshot;
  });
  return startupPromise;
};

export const getIdentityProviderStartupHealth = (): IdentityProviderStartupHealth | null =>
  startupHealth;

export const resetIdentityProviderStartupSnapshotForTest = (): void => {
  startupPromise = null;
  startupHealth = null;
};
