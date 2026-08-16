import pathModule from 'node:path';

import type { PlatformSecretService } from '../../security/secret';
import {
  compareSnapshots,
  decodePayload,
  type IdentityProviderLkgEnvelope,
  identityProviderLkgIdentity,
  type IdentityProviderLkgPayload,
  LKG_DOMAIN,
  LKG_FORMAT,
  LKG_WRITE_VERSION,
  mergeProviderTombstones,
  parsePayload,
  resolveLkgPath,
} from './lkg/codec';
import {
  assertSecureDirectory,
  ensureExistingTargetIsSecure,
  type IdentityProviderLkgTestHooks,
  withProcessWriteLock,
  writeSecureFileAtomically,
} from './lkg/secureFile';

export {
  IDENTITY_PROVIDER_LKG_VERSION,
  IDENTITY_PROVIDER_LKG_VERSION_V1,
  identityProviderLkgGeneration,
  identityProviderLkgIdentity,
  type IdentityProviderLkgPayload,
  type IdentityProviderLkgProvider,
  type IdentityProviderLkgProviderTombstone,
  type IdentityProviderLkgVersion,
} from './lkg/codec';
export {
  clearIdentityProviderRevocation,
  finalizeIdentityProviderRevocation,
  type IdentityProviderRevocationJournalEntry,
  readIdentityProviderRevocationJournal,
  recordIdentityProviderRevocation,
} from './lkg/revocationJournal';
export { IdentityProviderLkgError, type IdentityProviderLkgTestHooks } from './lkg/secureFile';

export type IdentityProviderLkgWriteResult = 'rejected' | 'unchanged' | 'written';

export type IdentityProviderLkgAdvanceSkipReason =
  | 'generation_overflow'
  | 'missing_input'
  | 'no_lkg'
  | 'read_failed'
  | 'stale_tombstone'
  | 'write_failed';

export type IdentityProviderLkgAdvanceResult =
  | IdentityProviderLkgWriteResult
  | { outcome: 'skipped'; reason: IdentityProviderLkgAdvanceSkipReason };

export const readIdentityProviderLkg = async (input: {
  /**
   * When false, skip max-age rejection so revoke-time LKG advances still work on
   * an aged but otherwise valid snapshot. Startup reads keep the default (true).
   */
  enforceAge?: boolean;
  env: Record<string, string | undefined>;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<IdentityProviderLkgPayload | null> => {
  const path = resolveLkgPath(input.env);
  try {
    await assertSecureDirectory(pathModule.dirname(path), false);
    return await decodePayload({
      ...input,
      enforceAge: input.enforceAge !== false,
      path,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const reportLkgAdvanceSkipped = (
  reason: IdentityProviderLkgAdvanceSkipReason,
  detail: { removedProviderId?: string },
): IdentityProviderLkgAdvanceResult => {
  // Safe diagnostics only — no secrets, ciphertext, or paths with env material.
  console.warn('[identityProvider.lkg] advance after tombstone skipped', {
    reason,
    removedProviderId: detail.removedProviderId ?? null,
  });
  return { outcome: 'skipped', reason };
};

/**
 * After a signed Disable (tombstone) commits to the database, advance the local
 * out-of-DB LKG so a total database outage in the immediate post-disable window
 * cannot resurrect the revoked provider from a pre-tombstone snapshot.
 *
 * Best-effort: missing LKG, secret/env unavailability, or write rejection must not
 * fail Disable itself. Read→merge→write is one serialized operation under the process
 * write lock so concurrent disables merge rather than resurrect each other. Per-provider
 * tombstone generations prevent a delayed older revoke from undoing a newer re-enable.
 */
export const advanceIdentityProviderLkgAfterTombstone = async (input: {
  env: Record<string, string | undefined>;
  removedProviderId: string;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
  tombstoneGeneration: string;
}): Promise<IdentityProviderLkgAdvanceResult> => {
  if (!input.tombstoneGeneration || !input.removedProviderId) {
    return reportLkgAdvanceSkipped('missing_input', {
      removedProviderId: input.removedProviderId,
    });
  }

  let path: string;
  try {
    path = resolveLkgPath(input.env);
  } catch {
    return reportLkgAdvanceSkipped('read_failed', {
      removedProviderId: input.removedProviderId,
    });
  }

  try {
    return await withProcessWriteLock(path, async () => {
      let current: IdentityProviderLkgPayload;
      try {
        await assertSecureDirectory(pathModule.dirname(path), false);
        current = await decodePayload({
          enforceAge: false,
          env: input.env,
          path,
          secrets: input.secrets,
          testHooks: input.testHooks,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reportLkgAdvanceSkipped('no_lkg', {
            removedProviderId: input.removedProviderId,
          });
        }
        return reportLkgAdvanceSkipped('read_failed', {
          removedProviderId: input.removedProviderId,
        });
      }

      const live = current.providers.find(
        (provider) => provider.providerId === input.removedProviderId,
      );
      const existingTombstones = current.providerTombstones ?? [];
      const existingTombGeneration = existingTombstones.find(
        (entry) => entry.providerId === input.removedProviderId,
      )?.generation;

      // Re-enable already landed with a generation at least as new as this tombstone.
      if (live && input.tombstoneGeneration <= live.generation) {
        return reportLkgAdvanceSkipped('stale_tombstone', {
          removedProviderId: input.removedProviderId,
        });
      }
      // Provider already removed and we already recorded an equal-or-newer tombstone.
      if (!live && existingTombGeneration && input.tombstoneGeneration <= existingTombGeneration) {
        return 'unchanged';
      }

      const providers = current.providers.filter(
        (provider) => provider.providerId !== input.removedProviderId,
      );
      if (
        providers.length === current.providers.length &&
        existingTombGeneration === input.tombstoneGeneration &&
        input.tombstoneGeneration <= current.generation
      ) {
        return 'unchanged';
      }

      const providerTombstones = mergeProviderTombstones(
        existingTombstones,
        [{ generation: input.tombstoneGeneration, providerId: input.removedProviderId }],
        providers,
      );

      let nextGeneration =
        input.tombstoneGeneration > current.generation
          ? input.tombstoneGeneration
          : `${current.generation}:tombstone`;
      if (nextGeneration <= current.generation) {
        nextGeneration = `${current.generation}:tombstone`;
      }
      if (nextGeneration.length > 512) {
        nextGeneration = nextGeneration.slice(0, 512);
        if (nextGeneration <= current.generation) {
          return reportLkgAdvanceSkipped('generation_overflow', {
            removedProviderId: input.removedProviderId,
          });
        }
      }

      return writeIdentityProviderLkgUnderLock({
        env: input.env,
        path,
        payload: {
          createdAt: new Date().toISOString(),
          domain: LKG_DOMAIN,
          generation: nextGeneration,
          identityRevision: identityProviderLkgIdentity(providers),
          providerTombstones,
          providers,
          version: LKG_WRITE_VERSION,
        },
        secrets: input.secrets,
        testHooks: input.testHooks,
      });
    });
  } catch {
    return reportLkgAdvanceSkipped('write_failed', {
      removedProviderId: input.removedProviderId,
    });
  }
};

/**
 * Write body that assumes the process write lock for `path` is already held.
 * Used by public write and by tombstone advance so read→merge→write stays atomic.
 * Always persists the current write version (v2) so on-disk shape is versioned.
 */
const writeIdentityProviderLkgUnderLock = async (input: {
  env: Record<string, string | undefined>;
  path: string;
  payload: IdentityProviderLkgPayload;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<IdentityProviderLkgWriteResult> => {
  // Normalize to write-version shape before compare/persist (v1 inputs upgrade on write).
  const requested = parsePayload({
    ...input.payload,
    providerTombstones: input.payload.providerTombstones ?? [],
    version: LKG_WRITE_VERSION,
  });
  const directory = pathModule.dirname(input.path);
  await assertSecureDirectory(directory, true);
  await ensureExistingTargetIsSecure(input.path);

  let current: IdentityProviderLkgPayload | null = null;
  try {
    current = await decodePayload({
      enforceAge: false,
      env: input.env,
      path: input.path,
      secrets: input.secrets,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const providerTombstones = mergeProviderTombstones(
    current?.providerTombstones,
    requested.providerTombstones,
    requested.providers,
  );
  const payload: IdentityProviderLkgPayload = {
    ...requested,
    providerTombstones,
    version: LKG_WRITE_VERSION,
  };

  if (current) {
    const comparison = compareSnapshots(current, payload);
    if (comparison !== 'upgrade') return comparison;
  }

  const plaintext = JSON.stringify(payload);
  const ciphertext = await input.secrets.encrypt(plaintext);
  const envelope: IdentityProviderLkgEnvelope = {
    ciphertext,
    format: LKG_FORMAT,
    signature: await input.secrets.signArtifact(LKG_DOMAIN, ciphertext),
    version: LKG_WRITE_VERSION,
  };
  await writeSecureFileAtomically({
    contents: JSON.stringify(envelope),
    path: input.path,
    testHooks: input.testHooks,
  });
  return 'written';
};

export const writeIdentityProviderLkg = async (input: {
  env: Record<string, string | undefined>;
  payload: IdentityProviderLkgPayload;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<IdentityProviderLkgWriteResult> => {
  const path = resolveLkgPath(input.env);
  return withProcessWriteLock(path, async () =>
    writeIdentityProviderLkgUnderLock({
      env: input.env,
      path,
      payload: input.payload,
      secrets: input.secrets,
      testHooks: input.testHooks,
    }),
  );
};
