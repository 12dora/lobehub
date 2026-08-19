import { createHash } from 'node:crypto';

import { and, inArray, isNull } from 'drizzle-orm';

import { withIdentityProviderPublishedRevisionLock } from '@/database/models/platform/identityProviderPublishedRevisionLock';
import { platformIdentityProviderSecrets } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type { RuntimeIdentityProvider } from '@/libs/better-auth/sso/platformIdentityProvider';

import type { PlatformSecretService } from '../../security/secret';
import type { IdentityProviderDiscoveryValidator } from './discoveryValidator';
import { resolveStaticIdentityProviderMetadata } from './kinds';
import type { IdentityProviderLkgPayload } from './lkg';
import { IDENTITY_PROVIDER_LKG_VERSION, writeIdentityProviderLkg } from './lkg';
import type { IdentityProviderStartupSnapshot } from './startupArtifact';
import type {
  DatabasePayload,
  DatabaseProviderRow,
  ValidatedTombstone,
} from './startupSnapshotPaths';
import { identityRevision, snapshotGeneration } from './startupSnapshotPaths';

const fingerprint = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

type DatabaseExecutor = LobeChatDatabase | Transaction;

type PublishedIdentityProviderSelection = {
  selected: Array<Omit<DatabaseProviderRow, 'secretCiphertext'>>;
  tombstoneGenerations: string[];
  tombstones: ValidatedTombstone[];
};

type LoadPublishedIdentityProviderSelection = (input: {
  db: DatabaseExecutor;
  environmentProviderIds: Set<string>;
}) => Promise<PublishedIdentityProviderSelection>;

const loadDatabasePayload = async (input: {
  db: DatabaseExecutor;
  environmentProviderIds: Set<string>;
  loadPublishedIdentityProviderSelection: LoadPublishedIdentityProviderSelection;
}): Promise<DatabasePayload> => {
  const selection = await input.loadPublishedIdentityProviderSelection({
    db: input.db,
    environmentProviderIds: input.environmentProviderIds,
  });
  const selected = selection.selected;
  if (selected.length === 0) {
    return {
      rows: [],
      tombstoneGenerations: selection.tombstoneGenerations,
      tombstones: selection.tombstones,
    };
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
  return {
    rows,
    tombstoneGenerations: selection.tombstoneGenerations,
    tombstones: selection.tombstones,
  };
};

type MaterializedIdentityProvider = Omit<RuntimeIdentityProvider, 'oidcMetadata'>;

export const materializeProviders = async (
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

export const enrichRuntimeProviders = async (
  providers: MaterializedIdentityProvider[],
  discovery: Pick<IdentityProviderDiscoveryValidator, 'discover'>,
): Promise<RuntimeIdentityProvider[]> =>
  Promise.all(
    providers.map(async (provider) => {
      // Kinds without a discovery document (DingTalk) must never make a boot-time network
      // call: their endpoints are static, so a slow/blocked IdP cannot degrade startup.
      const staticMetadata = resolveStaticIdentityProviderMetadata(provider.type, provider.issuer);
      return {
        ...provider,
        oidcMetadata: staticMetadata ?? (await discovery.discover(provider.issuer)),
      };
    }),
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
  // Persist signed revoke memory so LKG merges concurrent disables and blocks stale re-adds.
  // Written as v2 so legacy strict six-field v1 readers do not mis-parse this field.
  providerTombstones: [...payload.tombstones]
    .map((entry) => ({ generation: entry.generation, providerId: entry.providerId }))
    .sort((left, right) => left.providerId.localeCompare(right.providerId)),
  providers: payload.rows.map((row) => ({
    checksum: row.checksum,
    generation: row.generation,
    payload: row.payload as unknown as Record<string, unknown>,
    providerId: row.providerId,
    revision: row.revision,
    secretCiphertext: row.secretCiphertext,
    secretFingerprint: row.secretFingerprint,
  })),
  version: IDENTITY_PROVIDER_LKG_VERSION,
});

export const tryLoadDatabaseStartupSnapshot = async (input: {
  db?: LobeChatDatabase;
  discovery: Pick<IdentityProviderDiscoveryValidator, 'discover'>;
  env: Record<string, string | undefined>;
  environmentProviderIds: string[];
  environmentProviderIdSet: Set<string>;
  loadDatabase: () => Promise<LobeChatDatabase>;
  loadedAt: Date;
  loadPublishedIdentityProviderSelection: LoadPublishedIdentityProviderSelection;
  secrets: PlatformSecretService;
  testHooks?: {
    afterCanonicalRecheck?: () => Promise<void>;
  };
}): Promise<
  | {
      ok: true;
      snapshot: IdentityProviderStartupSnapshot;
      validatedTombstones: ValidatedTombstone[];
    }
  | { ok: false; error: unknown; validatedTombstones: ValidatedTombstone[] }
> => {
  /** Tombstones validated before a later live-provider failure — applied to LKG fallback. */
  let validatedTombstones: ValidatedTombstone[] = [];
  try {
    const db = input.db ?? (await input.loadDatabase());
    for (let attempt = 0; attempt < 2; attempt++) {
      // Capture tombstones before live secret/discovery materialization so a
      // co-provider failure cannot discard an already-validated revoke.
      try {
        const selection = await input.loadPublishedIdentityProviderSelection({
          db,
          environmentProviderIds: input.environmentProviderIdSet,
        });
        validatedTombstones = selection.tombstones;
      } catch {
        // Selection itself failed; LKG path may still run without tombstone filter.
      }
      const payload = await loadDatabasePayload({
        db,
        environmentProviderIds: input.environmentProviderIdSet,
        loadPublishedIdentityProviderSelection: input.loadPublishedIdentityProviderSelection,
      });
      validatedTombstones = payload.tombstones;
      // Secret integrity and every remote endpoint are validated before the
      // candidate is allowed to replace the last-known-good snapshot.
      const databaseProviders = await enrichRuntimeProviders(
        await materializeProviders(payload.rows, input.secrets),
        input.discovery,
      );
      const committed = await withIdentityProviderPublishedRevisionLock(db, async (tx) => {
        const currentPayload = await loadDatabasePayload({
          db: tx,
          environmentProviderIds: input.environmentProviderIdSet,
          loadPublishedIdentityProviderSelection: input.loadPublishedIdentityProviderSelection,
        });
        if (!databasePayloadMatches(payload, currentPayload)) return null;
        await input.testHooks?.afterCanonicalRecheck?.();

        let lastError: string | null = null;
        try {
          const writeResult = await writeIdentityProviderLkg({
            env: input.env,
            payload: toLkgPayload(currentPayload),
            secrets: input.secrets,
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
        ok: true,
        snapshot: {
          databaseProviders,
          generation: committed.generation,
          health: committed.lastError ? 'degraded' : 'healthy',
          identityRevision: committed.revision,
          lastError: committed.lastError,
          loadedAt: input.loadedAt,
          providerIds: [
            ...input.environmentProviderIds,
            ...databaseProviders.map((provider) => provider.providerKey),
          ],
          source: 'database',
        },
        validatedTombstones,
      };
    }
    throw new Error('PLATFORM_IDENTITY_PROVIDER_SNAPSHOT_CHANGED');
  } catch (error) {
    console.error('[identityProviderStartup] critical database snapshot failure', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    return { error, ok: false, validatedTombstones };
  }
};
