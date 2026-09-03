import { checksumPayload } from '@/database/models/platform';

import { SafeOutboundHttpError } from '../../security/outboundHttp';
import type { PlatformSecretService } from '../../security/secret';
import type { IdentityProviderDiscoveryValidator } from './discoveryValidator';
import { IdentityProviderValidationError } from './discoveryValidator';
import type { IdentityProviderLkgPayload, IdentityProviderRevocationJournalEntry } from './lkg';
import { readIdentityProviderLkg } from './lkg';
import { parsePublishedIdentityProviderPayload } from './publicationService';
import type { IdentityProviderStartupSnapshot } from './startupArtifact';
import { enrichRuntimeProviders, materializeProviders } from './startupSnapshotDatabaseLoad';
import type { DatabasePayload, ValidatedTombstone } from './startupSnapshotPaths';
import { errorCategory, identityRevision, snapshotGeneration } from './startupSnapshotPaths';

const mergeDurableRevocations = (
  entries: IdentityProviderRevocationJournalEntry[],
): Map<string, string | undefined> => {
  const durableByProviderId = new Map<string, string | undefined>();
  for (const entry of entries) {
    if (!durableByProviderId.has(entry.providerId)) {
      durableByProviderId.set(entry.providerId, entry.generation);
      continue;
    }
    const currentGeneration = durableByProviderId.get(entry.providerId);
    // A pending journal entry is an unresolved revoke and must dominate every
    // finalized entry regardless of token/serialization order.
    if (currentGeneration === undefined || entry.generation === undefined) {
      durableByProviderId.set(entry.providerId, undefined);
      continue;
    }
    durableByProviderId.set(
      entry.providerId,
      entry.generation > currentGeneration ? entry.generation : currentGeneration,
    );
  }
  return durableByProviderId;
};

const fromLkgPayload = (
  payload: IdentityProviderLkgPayload,
  environmentProviderIds: Set<string>,
  /**
   * Tombstones validated from the (partially successful) database selection.
   * Applied even when live-provider materialization failed so LKG cannot
   * resurrect a provider that already has a signed revoke in the database.
   */
  validatedTombstones: ValidatedTombstone[] = [],
  durableRevocations: IdentityProviderRevocationJournalEntry[] = [],
): DatabasePayload => {
  const removedProviderIds = new Set(validatedTombstones.map((entry) => entry.providerId));
  const durableByProviderId = mergeDurableRevocations(durableRevocations);
  return {
    rows: payload.providers.flatMap((provider) => {
      if (removedProviderIds.has(provider.providerId)) return [];
      const durableGeneration = durableByProviderId.get(provider.providerId);
      // Pending entries have no generation and always fail closed. Finalized
      // entries filter only snapshots at or before the committed tombstone, so
      // a later published re-enable remains recoverable.
      if (
        durableByProviderId.has(provider.providerId) &&
        (durableGeneration === undefined || provider.generation <= durableGeneration)
      )
        return [];
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
    tombstoneGenerations: validatedTombstones.map((entry) => entry.generation),
    tombstones: validatedTombstones,
  };
};

export const tryLoadLkgFallback = async (input: {
  databaseError: unknown;
  discovery: Pick<IdentityProviderDiscoveryValidator, 'discover'>;
  durableRevocations: IdentityProviderRevocationJournalEntry[] | null;
  env: Record<string, string | undefined>;
  environmentProviderIds: string[];
  loadedAt: Date;
  secrets: PlatformSecretService;
  validatedTombstones: ValidatedTombstone[];
}): Promise<
  { ok: true; snapshot: IdentityProviderStartupSnapshot } | { error?: unknown; ok: false }
> => {
  try {
    if (!input.durableRevocations) {
      throw new Error('PLATFORM_IDENTITY_PROVIDER_REVOCATION_JOURNAL_UNAVAILABLE');
    }
    const lkg = await readIdentityProviderLkg({ env: input.env, secrets: input.secrets });
    if (lkg) {
      // Apply validated tombstone removals even when live materialization failed.
      const payload = fromLkgPayload(
        lkg,
        new Set(input.environmentProviderIds),
        input.validatedTombstones,
        input.durableRevocations,
      );
      const databaseProviders = await enrichRuntimeProviders(
        await materializeProviders(payload.rows, input.secrets),
        input.discovery,
      );
      return {
        ok: true,
        snapshot: {
          databaseProviders,
          generation: snapshotGeneration(payload),
          health: 'degraded',
          identityRevision: identityRevision(payload.rows),
          lastError: errorCategory(input.databaseError),
          loadedAt: input.loadedAt,
          providerIds: [
            ...input.environmentProviderIds,
            ...databaseProviders
              .map((provider) => provider.providerKey)
              .filter((provider) => !input.environmentProviderIds.includes(provider)),
          ],
          source: 'lkg',
        },
      };
    }
    return { ok: false };
  } catch (error) {
    console.error('[identityProviderStartup] critical LKG snapshot failure', {
      ...(error instanceof IdentityProviderValidationError || error instanceof SafeOutboundHttpError
        ? { code: error.code }
        : {}),
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof SafeOutboundHttpError ? { message: error.message } : {}),
    });
    return { error, ok: false };
  }
};
