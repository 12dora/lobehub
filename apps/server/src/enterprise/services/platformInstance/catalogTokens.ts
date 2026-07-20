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
