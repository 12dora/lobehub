import type { AdminAgentDetailOutput } from './types';

/** Version rows as they appear on the admin Agent detail aggregate. */
export type PlatformAgentVersionRow = AdminAgentDetailOutput['versions'][number];

/**
 * Canonical admin version order: newest `createdAt` first, opaque `id` descending as a
 * stable tie-break. Version IDs are generated identifiers and MUST NOT be treated as creation
 * order on their own.
 */
export const comparePlatformAgentVersionsDesc = (
  left: Pick<PlatformAgentVersionRow, 'createdAt' | 'id'>,
  right: Pick<PlatformAgentVersionRow, 'createdAt' | 'id'>,
): number => {
  const leftTime = new Date(left.createdAt).getTime();
  const rightTime = new Date(right.createdAt).getTime();
  if (rightTime !== leftTime) return rightTime - leftTime;
  return right.id.localeCompare(left.id);
};

/** Sort a version collection into canonical newest-first order (does not mutate the input). */
export const sortPlatformAgentVersionsDesc = <
  T extends Pick<PlatformAgentVersionRow, 'createdAt' | 'id'>,
>(
  versions: readonly T[],
): T[] => [...versions].sort(comparePlatformAgentVersionsDesc);

/** Most recently created version (canonical aggregate order), or undefined when empty. */
export const selectLatestPlatformAgentVersion = <
  T extends Pick<PlatformAgentVersionRow, 'createdAt' | 'id'>,
>(
  versions: readonly T[],
): T | undefined => sortPlatformAgentVersionsDesc(versions)[0];

/** Published pointer version when present; never falls back to array position. */
export const selectCurrentPlatformAgentVersion = (
  snapshot: Pick<AdminAgentDetailOutput, 'identity' | 'versions'>,
): PlatformAgentVersionRow | undefined =>
  snapshot.versions.find(({ id }) => id === snapshot.identity.currentVersionId);

/**
 * Source version for seeding a new draft: the newest created version, falling back to the
 * published pointer only when the collection is empty of other rows (should not happen once
 * a pointer exists). Never uses opaque array order.
 */
export const selectDraftSourcePlatformAgentVersion = (
  snapshot: Pick<AdminAgentDetailOutput, 'identity' | 'versions'>,
): PlatformAgentVersionRow | undefined =>
  selectLatestPlatformAgentVersion(snapshot.versions) ??
  selectCurrentPlatformAgentVersion(snapshot);
