import { identityProviderLkgGeneration, identityProviderLkgIdentity } from './lkg';
import type { PublishedIdentityProviderPayload } from './publicationService';
import type { IdentityProviderStartupSnapshot } from './startupArtifact';

export type ValidatedTombstone = { generation: string; providerId: string; revision: number };

export type DatabaseProviderRow = {
  checksum: string;
  generation: string;
  payload: PublishedIdentityProviderPayload;
  providerId: string;
  revision: number;
  secretCiphertext: string;
  secretFingerprint: string;
};

export type DatabasePayload = {
  rows: DatabaseProviderRow[];
  /** Generations from signed tombstones (enabled:false) so LKG advances on revoke. */
  tombstoneGenerations: string[];
  /** Provider IDs of validated tombstones — applied to LKG fallback even if live materialization fails. */
  tombstones: ValidatedTombstone[];
};

export const errorCategory = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('LKG_STALE')) return 'lkg_stale';
  if (message.includes('SIGNATURE')) return 'lkg_signature_invalid';
  if (message.includes('PERMISSION') || message.includes('OWNER')) return 'lkg_permissions_invalid';
  if (message.includes('SECRET')) return 'secret_unavailable';
  return 'startup_snapshot_unavailable';
};

export const identityRevision = (
  providers: Array<{
    checksum: string;
    generation: string;
    payload: { providerKey: string; secretFingerprint: string };
    providerId: string;
    revision: number;
    secretFingerprint: string;
  }>,
): string => identityProviderLkgIdentity(providers);

export const snapshotGeneration = (payload: DatabasePayload): string =>
  identityProviderLkgGeneration([
    ...payload.rows,
    ...payload.tombstoneGenerations.map((generation) => ({ generation })),
  ]);

export const environmentOnlySnapshot = (input: {
  environmentProviderIds: string[];
  loadedAt: Date;
}): IdentityProviderStartupSnapshot => ({
  databaseProviders: [],
  generation: null,
  health: 'healthy',
  identityRevision: null,
  lastError: null,
  loadedAt: input.loadedAt,
  providerIds: input.environmentProviderIds,
  source: 'environment',
});

export const emptyPublishedSnapshot = (input: {
  environmentProviderIds: string[];
  loadedAt: Date;
  tombstoneGenerations: string[];
  tombstones: ValidatedTombstone[];
}): IdentityProviderStartupSnapshot => {
  const emptyPayload: DatabasePayload = {
    rows: [],
    tombstoneGenerations: input.tombstoneGenerations,
    tombstones: input.tombstones,
  };
  return {
    databaseProviders: [],
    generation: snapshotGeneration(emptyPayload),
    health: 'healthy',
    identityRevision: identityRevision([]),
    lastError: null,
    loadedAt: input.loadedAt,
    providerIds: input.environmentProviderIds,
    // Env-only SSO must not be labelled "published in admin".
    source: input.environmentProviderIds.length > 0 ? 'environment' : 'database',
  };
};

export const breakGlassSnapshot = (input: {
  environmentProviderIds: string[];
  error: unknown;
  loadedAt: Date;
}): IdentityProviderStartupSnapshot => ({
  databaseProviders: [],
  generation: null,
  health: 'degraded',
  identityRevision: null,
  lastError: errorCategory(input.error),
  loadedAt: input.loadedAt,
  providerIds: input.environmentProviderIds,
  source: 'break_glass',
});
