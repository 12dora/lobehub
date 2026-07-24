import { PlatformSkillCatalogRepository } from '../../repositories/platformSkillCatalog';
import type { PlatformResourceStatus } from '../../schemas/platform';
import { PlatformRevisionConflictError } from './errors';
import type { ResourcePointerAdapter } from './revision';
import {
  buildPublishedSnapshot,
  draftView,
  parsePlatformPublishedSkillSnapshot,
  platformSkillDraftToken,
  type PlatformSkillDraftView,
} from './skillCanonicalize';

export interface PlatformSkillPointerAdapterParams {
  actorUserId?: string;
  builtinOverrideTombstone?: boolean;
  expectedDraftToken: string;
  skillId: string;
  versionId: string;
}

/**
 * Atomic revision adapter for Skill publish/rollback. Published identity fields are
 * immutable revision payload; mutable draft columns are never used by runtime reads.
 */
export const createPlatformSkillPointerAdapter = (
  params: PlatformSkillPointerAdapterParams,
): ResourcePointerAdapter => {
  let lockedDraft: PlatformSkillDraftView | undefined;
  return {
    assertLockedState: async () => {
      if (!lockedDraft || platformSkillDraftToken(lockedDraft) !== params.expectedDraftToken) {
        throw new PlatformRevisionConflictError('Skill draft token changed');
      }
    },
    lockAndGetRevision: async (tx) => {
      lockedDraft = draftView(
        await new PlatformSkillCatalogRepository(tx).lockSkill(params.skillId),
      );
      if (!lockedDraft) throw new Error('Skill not found');
      return lockedDraft.revision;
    },
    materializePublished: async (tx, { payload, revision, status }) => {
      const snapshot = parsePlatformPublishedSkillSnapshot(payload);
      if (!lockedDraft || !snapshot || snapshot.skill.skillKey !== lockedDraft.skillKey) {
        throw new Error('Published Skill snapshot is invalid');
      }
      const repository = new PlatformSkillCatalogRepository(tx);
      const version = await repository.getVersion(params.skillId, snapshot.versionId);
      if (!version) throw new Error('Published Skill version is unavailable');
      await repository.updateSkill(params.skillId, {
        currentVersionId: version.id,
        revision,
        status: status as PlatformResourceStatus,
        updatedBy: params.actorUserId,
      });
    },
    prepareLockedPublish: async (tx) => {
      if (!lockedDraft) throw new Error('Skill must be locked before publishing');
      const version = await new PlatformSkillCatalogRepository(tx).getVersion(
        params.skillId,
        params.versionId,
      );
      if (!version) throw new Error('Published Skill version is unavailable');
      // Archived builtin-override tombstones must remain eligible regardless of the
      // mutable draft's `enabled` flag — otherwise archiving a disabled draft can
      // silently resurrect the bundled skill organization-wide.
      const snapshot = buildPublishedSnapshot(lockedDraft, version.id);
      const payload = {
        ...snapshot,
        skill: {
          ...snapshot.skill,
          ...(params.builtinOverrideTombstone ? { enabled: true } : {}),
        },
        ...(params.builtinOverrideTombstone ? { builtinOverrideTombstone: true as const } : {}),
      };
      return {
        afterDiff: payload as unknown as Record<string, unknown>,
        payload: payload as unknown as Record<string, unknown>,
      };
    },
    updatePointer: async (tx, { revision }) => {
      await new PlatformSkillCatalogRepository(tx).updateSkill(params.skillId, {
        revision,
        updatedBy: params.actorUserId,
      });
    },
  };
};
