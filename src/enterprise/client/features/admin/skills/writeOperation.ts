import { fingerprintSkillSnapshot } from './controller';
import type { AdminSkillGetOutput, AdminSkillVersionSummary } from './types';

const STALE_WRITE_ERROR = 'PLATFORM_REVISION_CONFLICT';

export interface SkillWriteSnapshot {
  baseRevision: number;
  draftToken: string;
  fingerprint: string;
  id: string;
  targetVersionId?: string;
  versionId?: string;
}

export const freezeSkillWriteSnapshot = (
  data: AdminSkillGetOutput,
  version?: { targetVersionId?: string; versionId?: string },
): Readonly<SkillWriteSnapshot> =>
  Object.freeze({
    baseRevision: data.baseRevision,
    draftToken: data.draftToken,
    fingerprint: fingerprintSkillSnapshot(data),
    id: data.draft.id,
    ...version,
  });

export const rollbackableSkillVersions = (
  versions: readonly AdminSkillVersionSummary[],
): AdminSkillVersionSummary[] =>
  versions.filter((version) => version.lastPublishedRevision !== null);

export interface SkillWriteEpochGuard {
  assertCurrent: (epoch: number, resourceId: string) => void;
  begin: (resourceId: string) => number | null;
  invalidate: () => void;
  lock: () => void;
  unlock: () => void;
}

export const createSkillWriteEpochGuard = (): SkillWriteEpochGuard => {
  let epoch = 0;
  let locked = false;
  let resourceId: string | null = null;

  return {
    assertCurrent: (candidate, candidateResourceId) => {
      if (locked || candidate !== epoch || candidateResourceId !== resourceId) {
        throw new Error(STALE_WRITE_ERROR);
      }
    },
    begin: (nextResourceId) => {
      if (locked) return null;
      epoch += 1;
      resourceId = nextResourceId;
      return epoch;
    },
    invalidate: () => {
      epoch += 1;
      resourceId = null;
    },
    lock: () => {
      locked = true;
      epoch += 1;
      resourceId = null;
    },
    unlock: () => {
      locked = false;
    },
  };
};
