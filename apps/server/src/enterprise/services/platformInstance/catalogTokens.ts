import { checksumPayload } from '@/database/models/platform/checksum';
import type { PlatformRevisionToken } from '@/server/enterprise/contracts/platformInstanceStatus';

export interface AiCatalogTokenEntry {
  checksum: string | null;
  providerId: string;
  providerKey: string;
  revision: number;
  secretFingerprint: string | null;
}

export interface SkillCatalogTokenEntry {
  checksum: string | null;
  currentVersionId: string | null;
  revision: number;
  skillId: string;
  skillKey: string;
  tombstone: boolean;
}

export interface SkillCatalogBuiltinTokenEntry {
  checksum: string;
  skillKey: string;
  version: string;
}

export class PlatformCatalogTokenInvariantError extends Error {
  readonly code = 'PLATFORM_CONFIG_VALIDATION_FAILED' as const;

  constructor() {
    super('PLATFORM_CATALOG_TOKEN_INVARIANT');
    this.name = 'PlatformCatalogTokenInvariantError';
  }
}

const isChecksum = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

const compareCodepoint = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

type ImmutablePlatformRevisionToken = Extract<PlatformRevisionToken, { kind: 'immutable_id' }>;

const immutableToken = (value: unknown): ImmutablePlatformRevisionToken => ({
  kind: 'immutable_id',
  value: checksumPayload(value),
});

/**
 * Process-local incremental aggregate authority token.
 *
 * Writers call {@link invalidate} after a successful catalog mutation so the next
 * poll rebuilds. Steady-state polls hit {@link peek} / {@link peekAt} and perform
 * **no** catalog-wide scan/hash — O(1) generation compare only.
 *
 * Multi-instance correctness: call {@link peekAt} with the persisted generation from
 * a single PK read of `platform_catalog_authority`. When that generation advances,
 * rebuild once; otherwise serve the cached token.
 *
 * Work counters (`rebuilds`, `rowsScanned`, `entryHashes`, `pkReads`) are for tests
 * that must assert actual per-poll work is bounded.
 */
export class IncrementalCatalogAuthorityToken {
  /** Local dirty epoch advanced by {@link invalidate} (same-process fast signal). */
  private localEpoch = 0;
  private slot: {
    localEpoch: number;
    persistedGeneration: number | null;
    token: PlatformRevisionToken;
  } | null = null;
  private rebuilds = 0;
  private rowsScanned = 0;
  private entryHashes = 0;
  private peeks = 0;
  private pkReads = 0;

  get stats(): {
    entryHashes: number;
    generation: number;
    localEpoch: number;
    peeks: number;
    pkReads: number;
    rebuilds: number;
    rowsScanned: number;
  } {
    return {
      entryHashes: this.entryHashes,
      generation: this.localEpoch,
      localEpoch: this.localEpoch,
      peeks: this.peeks,
      pkReads: this.pkReads,
      rebuilds: this.rebuilds,
      rowsScanned: this.rowsScanned,
    };
  }

  /** Snapshot the local invalidation epoch for in-flight rebuild coalescing. */
  get epoch(): number {
    return this.localEpoch;
  }

  clear = (): void => {
    this.localEpoch = 0;
    this.slot = null;
    this.rebuilds = 0;
    this.rowsScanned = 0;
    this.entryHashes = 0;
    this.peeks = 0;
    this.pkReads = 0;
  };

  /** Advance the local dirty epoch; next poll must rebuild the authority token. */
  invalidate = (): void => {
    this.localEpoch += 1;
  };

  /**
   * Record that a single PK generation read was performed (for test work accounting).
   * Call once per reconcile attempt that touches `platform_catalog_authority`.
   */
  recordPkRead = (): void => {
    this.pkReads += 1;
  };

  /**
   * O(1) hit when the local epoch is unchanged since the last rebuild and no
   * persisted-generation binding is required (single-process / unit tests).
   * Does not touch catalog rows or hash entry sets.
   */
  peek = (): PlatformRevisionToken | undefined => {
    this.peeks += 1;
    if (this.slot && this.slot.localEpoch === this.localEpoch) {
      return this.slot.token;
    }
    return undefined;
  };

  /**
   * O(1) hit when both the local epoch and the persisted generation match the
   * last rebuild. Call after a single PK read of `platform_catalog_authority`.
   */
  peekAt = (persistedGeneration: number): PlatformRevisionToken | undefined => {
    this.peeks += 1;
    if (
      this.slot &&
      this.slot.localEpoch === this.localEpoch &&
      this.slot.persistedGeneration === persistedGeneration
    ) {
      return this.slot.token;
    }
    return undefined;
  };

  /** Store a freshly built authority token for the current local epoch. */
  put = (
    token: PlatformRevisionToken,
    work: { entryHashes?: number; rowsScanned?: number } = {},
    persistedGeneration: number | null = null,
  ): PlatformRevisionToken => {
    this.rebuilds += 1;
    this.rowsScanned += work.rowsScanned ?? 0;
    this.entryHashes += work.entryHashes ?? 0;
    this.slot = {
      localEpoch: this.localEpoch,
      persistedGeneration,
      token,
    };
    return token;
  };
}

/** Process-wide incremental authority tokens for health-poll target domains. */
export const aiCatalogAuthorityToken = new IncrementalCatalogAuthorityToken();
export const skillCatalogAuthorityToken = new IncrementalCatalogAuthorityToken();

/** Call after a successful AI-catalog publish / pointer mutation (same process). */
export const invalidateAiCatalogAuthorityToken = (): void => {
  aiCatalogAuthorityToken.invalidate();
};

/** Call after a successful Skill-catalog publish / pointer mutation (same process). */
export const invalidateSkillCatalogAuthorityToken = (): void => {
  skillCatalogAuthorityToken.invalidate();
};

/** Shared authority for both the system target and the process AI projection. */
export const buildAiCatalogRevisionToken = (
  input: readonly AiCatalogTokenEntry[],
): ImmutablePlatformRevisionToken => {
  if (
    input.some(
      ({ checksum, providerId, providerKey, revision }) =>
        !providerId || !providerKey || revision <= 0 || !isChecksum(checksum),
    )
  ) {
    throw new PlatformCatalogTokenInvariantError();
  }
  const canonical = input
    .map(({ checksum, providerId, providerKey, revision, secretFingerprint }) => ({
      checksum,
      providerId,
      providerKey,
      revision,
      secretFingerprint,
    }))
    .sort(
      (left, right) =>
        compareCodepoint(left.providerKey, right.providerKey) ||
        compareCodepoint(left.providerId, right.providerId),
    );
  return immutableToken(canonical);
};

/** Shared authority for the active Skill projection, including builtins and override tombstones. */
export const buildSkillCatalogRevisionToken = (input: {
  builtins: readonly SkillCatalogBuiltinTokenEntry[];
  platform: readonly SkillCatalogTokenEntry[];
}): ImmutablePlatformRevisionToken => {
  if (
    input.builtins.some(
      ({ checksum, skillKey, version }) => !skillKey || !version || !isChecksum(checksum),
    ) ||
    input.platform.some(
      ({ checksum, currentVersionId, revision, skillId, skillKey }) =>
        !skillId || !skillKey || revision <= 0 || !currentVersionId || !isChecksum(checksum),
    )
  ) {
    throw new PlatformCatalogTokenInvariantError();
  }
  const builtins = input.builtins
    .map(({ checksum, skillKey, version }) => ({ checksum, skillKey, version }))
    .sort((left, right) => compareCodepoint(left.skillKey, right.skillKey));
  const platform = input.platform
    .map(({ checksum, currentVersionId, revision, skillId, skillKey, tombstone }) => ({
      checksum,
      currentVersionId,
      revision,
      skillId,
      skillKey,
      tombstone,
    }))
    .sort(
      (left, right) =>
        compareCodepoint(left.skillKey, right.skillKey) ||
        compareCodepoint(left.skillId, right.skillId),
    );
  return immutableToken({ builtins, platform });
};

/**
 * Resolve an AI catalog authority token using the process incremental store.
 * Steady-state polls with an unchanged generation return the cached token without
 * hashing the entry set.
 */
export const resolveAiCatalogTargetToken = (
  entries: readonly AiCatalogTokenEntry[],
  store: IncrementalCatalogAuthorityToken = aiCatalogAuthorityToken,
  persistedGeneration: number | null = null,
): PlatformRevisionToken => {
  const hit = persistedGeneration === null ? store.peek() : store.peekAt(persistedGeneration);
  if (hit) return hit;
  return store.put(
    buildAiCatalogRevisionToken(entries),
    {
      entryHashes: 1,
      rowsScanned: entries.length,
    },
    persistedGeneration,
  );
};

/**
 * Resolve a Skill catalog authority token using the process incremental store.
 * Steady-state polls do not re-hash builtins + platform entries.
 */
export const resolveSkillCatalogTargetToken = (
  input: {
    builtins: readonly SkillCatalogBuiltinTokenEntry[];
    platform: readonly SkillCatalogTokenEntry[];
  },
  store: IncrementalCatalogAuthorityToken = skillCatalogAuthorityToken,
  persistedGeneration: number | null = null,
): PlatformRevisionToken => {
  const hit = persistedGeneration === null ? store.peek() : store.peekAt(persistedGeneration);
  if (hit) return hit;
  return store.put(
    buildSkillCatalogRevisionToken(input),
    {
      entryHashes: 1,
      rowsScanned: input.builtins.length + input.platform.length,
    },
    persistedGeneration,
  );
};
