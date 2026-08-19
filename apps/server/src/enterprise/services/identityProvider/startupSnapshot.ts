import { and, desc, eq } from 'drizzle-orm';

import { checksumPayload } from '@/database/models/platform';
import { platformResourceRevisions } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretService } from '../../security/secret';
import { IdentityProviderDiscoveryValidator } from './discoveryValidator';
import type { IdentityProviderRevocationJournalEntry } from './lkg';
import { readIdentityProviderRevocationJournal } from './lkg';
import { resolveIdentityProviderOutboundMode } from './outboundMode';
import { parsePublishedIdentityProviderPayload } from './publicationService';
import {
  commitIdentityProviderStartupFailure,
  commitIdentityProviderStartupSnapshot,
  type IdentityProviderStartupSnapshot,
  markIdentityProviderStartupLoading,
  resetIdentityProviderStartupArtifactForTest,
} from './startupArtifact';
import { tryLoadDatabaseStartupSnapshot } from './startupSnapshotDatabaseLoad';
import { tryLoadLkgFallback } from './startupSnapshotLkgFallback';
import {
  breakGlassSnapshot,
  emptyPublishedSnapshot,
  environmentOnlySnapshot,
} from './startupSnapshotPaths';

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
  /**
   * Signed tombstones (enabled:false). Kept independently of live materialization so
   * LKG fallback can still apply monotonic removals when a co-provider fails validation.
   */
  const tombstones: Array<{ generation: string; providerId: string; revision: number }> = [];
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
      tombstones.push({ generation, providerId: row.resourceId, revision: row.revision });
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
  return {
    environmentShadowed,
    selected,
    tombstoneGenerations: tombstones.map((entry) => entry.generation),
    tombstones,
  };
};

const loadDatabase = async (): Promise<LobeChatDatabase> => {
  const database = await import('@lobechat/database');
  return database.serverDB;
};

const loadUncached = async (options: LoadOptions): Promise<IdentityProviderStartupSnapshot> => {
  const env = options.env ?? process.env;
  const environmentProviderIds = parseEnvironmentIdentityProviderIds(env);
  const loadedAt = new Date();
  if (!parseEnterpriseFeatureFlags(env).ENABLE_DATABASE_OIDC) {
    return environmentOnlySnapshot({ environmentProviderIds, loadedAt });
  }

  const secrets = PlatformSecretService.tryFromEnv(env);
  const discovery =
    options.discovery ??
    new IdentityProviderDiscoveryValidator(
      new SafeOutboundHttpClient({ mode: resolveIdentityProviderOutboundMode(env) }),
    );
  const environmentProviderIdSet = new Set(environmentProviderIds);
  let databaseError: unknown = new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE');

  // Select published revisions before requiring secrets so "nothing published"
  // is a healthy empty database snapshot, not break-glass.
  let publishedSelection: Awaited<
    ReturnType<typeof loadPublishedIdentityProviderSelection>
  > | null = null;
  try {
    const db = options.db ?? (await loadDatabase());
    publishedSelection = await loadPublishedIdentityProviderSelection({
      db,
      environmentProviderIds: environmentProviderIdSet,
    });
  } catch (error) {
    databaseError = error;
  }

  if (publishedSelection && publishedSelection.selected.length === 0) {
    return emptyPublishedSnapshot({
      environmentProviderIds,
      loadedAt,
      tombstoneGenerations: publishedSelection.tombstoneGenerations,
      tombstones: publishedSelection.tombstones,
    });
  }

  if (publishedSelection && publishedSelection.selected.length > 0 && !secrets) {
    return breakGlassSnapshot({
      environmentProviderIds,
      error: databaseError,
      loadedAt,
    });
  }

  if (secrets) {
    let durableRevocations: IdentityProviderRevocationJournalEntry[] | null = null;
    try {
      durableRevocations = await readIdentityProviderRevocationJournal({ env, secrets });
    } catch (error) {
      console.error('[identityProviderStartup] revocation journal unavailable', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    const databaseResult = await tryLoadDatabaseStartupSnapshot({
      db: options.db,
      discovery,
      env,
      environmentProviderIds,
      environmentProviderIdSet,
      loadDatabase,
      loadedAt,
      loadPublishedIdentityProviderSelection,
      secrets,
      testHooks: options.testHooks,
    });
    if (databaseResult.ok) return databaseResult.snapshot;
    databaseError = databaseResult.error;

    const lkgResult = await tryLoadLkgFallback({
      databaseError,
      discovery,
      durableRevocations,
      env,
      environmentProviderIds,
      loadedAt,
      secrets,
      validatedTombstones: databaseResult.validatedTombstones,
    });
    if (lkgResult.ok) return lkgResult.snapshot;
    if (lkgResult.error !== undefined) databaseError = lkgResult.error;
  }

  return breakGlassSnapshot({
    environmentProviderIds,
    error: databaseError,
    loadedAt,
  });
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
