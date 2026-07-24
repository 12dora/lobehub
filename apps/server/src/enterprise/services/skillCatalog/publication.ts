import {
  createPlatformSkillPointerAdapter,
  draftView,
  PlatformRevisionConflictError,
  platformSkillDraftToken,
  type ResourcePointerAdapter,
} from '@/database/models/platform';
import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformAuditService } from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { PlatformPublisherService } from '../platformPublisher';
import { SkillCatalogNotFoundError, SkillCatalogValidationError } from './errors';
import { invalidatePublishedSkillCatalogReadCache } from './readService';
import { SkillCatalogValidationService } from './validationService';

interface PublicationInput {
  expectedDraftToken: string;
  expectedRevision: number;
  id: string;
  reason: string;
}

export interface PublishSkillInput extends PublicationInput {
  versionId: string;
}

export interface RollbackSkillInput extends PublicationInput {
  targetVersionId: string;
}

export interface SkillCatalogPublicationOptions {
  invalidation?: PlatformConfigInvalidationPublisher;
  validation?: ConstructorParameters<typeof SkillCatalogValidationService>[0];
}

const catalogRevision = (skillId: string, revision: number) => `${skillId}:${revision}`;

export class SkillCatalogPublicationService {
  private readonly publisher: PlatformPublisherService;
  private readonly validation: SkillCatalogValidationService;

  constructor(
    private readonly db: LobeChatDatabase,
    options: SkillCatalogPublicationOptions = {},
  ) {
    this.publisher = new PlatformPublisherService(db, options.invalidation);
    this.validation = new SkillCatalogValidationService(options.validation);
  }

  private appendFailureAudit = async (params: {
    action: string;
    actorUserId: string;
    reason: string;
    targetId: string;
  }) => {
    await new PlatformAuditService(this.db).append({
      action: params.action,
      actorUserId: params.actorUserId,
      afterDiff: { error: 'skill_catalog_mutation_failed' },
      reason: params.reason,
      result: 'failure',
      targetId: params.targetId,
      targetType: 'skill',
    });
  };

  private createPointer = (params: {
    actorUserId: string;
    builtinOverrideTombstone?: boolean;
    expectedDraftToken: string;
    skillId: string;
    validateVersion?: boolean;
    versionId: string;
  }): ResourcePointerAdapter => {
    const base = createPlatformSkillPointerAdapter(params);
    return {
      ...base,
      assertLockedState: async (tx, args) => {
        await base.assertLockedState?.(tx, args);
        await acquirePlatformDependencyPublicationLock(tx);
        if (!params.validateVersion) return;
        const result = await this.validation.validateStoredVersion(
          tx,
          params.skillId,
          params.versionId,
        );
        const errors = result.issues.filter((issue) => issue.severity === 'error');
        if (errors.length > 0) throw new SkillCatalogValidationError(errors);
      },
    };
  };

  publish = async (actorUserId: string, input: PublishSkillInput) => {
    try {
      const version = await new PlatformSkillCatalogRepository(this.db).getVersion(
        input.id,
        input.versionId,
      );
      if (!version) throw new SkillCatalogNotFoundError();
      const result = await this.publisher.publish({
        actorUserId,
        expectedRevision: input.expectedRevision,
        invalidationScopes: ['skill-catalog', 'skill-runtime'],
        payload: {},
        pointer: this.createPointer({
          actorUserId,
          expectedDraftToken: input.expectedDraftToken,
          skillId: input.id,
          validateVersion: true,
          versionId: input.versionId,
        }),
        reason: input.reason,
        resourceId: input.id,
        resourceType: 'skill',
      });
      invalidatePublishedSkillCatalogReadCache();
      return {
        auditId: result.auditId,
        catalogRevision: catalogRevision(input.id, result.revision.revision),
        revision: result.revision.revision,
        skillId: input.id,
        status: 'published' as const,
        versionId: input.versionId,
      };
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.skills.publish',
        actorUserId,
        reason: input.reason,
        targetId: input.id,
      });
      throw error;
    }
  };

  /**
   * Never-published shells (no currentVersionId) cannot go through the revision
   * pointer adapter. CAS-archive them to status=archived while keeping revision 0
   * so the runtime authority scan (`revision > 0`) never sees a pointerless row.
   * Draft sequence still advances for CAS / fingerprint; mutations treat archived
   * as terminal.
   */
  private archiveNeverPublished = async (actorUserId: string, input: PublicationInput) => {
    const result = await this.db.transaction(async (tx) => {
      const repository = new PlatformSkillCatalogRepository(tx);
      const locked = await repository.lockSkill(input.id);
      const draft = draftView(locked);
      if (!draft) throw new SkillCatalogNotFoundError();
      // Concurrent publish may have set a pointer — fail closed so the caller retries
      // the normal archive path with a fresh draft token.
      if (locked?.currentVersionId) {
        throw new PlatformRevisionConflictError('Skill draft changed', {
          currentRevision: draft.revision,
          expectedRevision: input.expectedRevision,
          resourceId: input.id,
          resourceType: 'skill',
        });
      }
      if (draft.status === 'archived') throw new SkillCatalogNotFoundError();
      if (
        draft.revision !== input.expectedRevision ||
        platformSkillDraftToken(draft) !== input.expectedDraftToken
      ) {
        throw new PlatformRevisionConflictError('Skill draft changed', {
          currentRevision: draft.revision,
          expectedRevision: input.expectedRevision,
          resourceId: input.id,
          resourceType: 'skill',
        });
      }
      // Keep revision at 0 (never published). Bumping to a positive pointer without a
      // resource_revision + currentVersionId breaks loadCurrentSkillCatalogSnapshot.
      await repository.updateSkillDraft(input.id, {
        status: 'archived',
        updatedBy: actorUserId,
      });
      const audit = await new PlatformAuditService(tx).append({
        action: 'admin.skills.archive',
        actorUserId,
        afterDiff: { neverPublished: true, revision: 0, status: 'archived' },
        reason: input.reason,
        result: 'success',
        targetId: input.id,
        targetType: 'skill',
      });
      return { auditId: audit.id, revision: 0 as const };
    });
    invalidatePublishedSkillCatalogReadCache();
    return {
      auditId: result.auditId,
      catalogRevision: catalogRevision(input.id, result.revision),
      revision: result.revision,
      skillId: input.id,
      status: 'archived' as const,
      versionId: null as string | null,
    };
  };

  archive = async (actorUserId: string, input: PublicationInput) => {
    try {
      const skill = await new PlatformSkillCatalogRepository(this.db).getSkill(input.id);
      if (!skill) throw new SkillCatalogNotFoundError();
      if (!skill.currentVersionId) {
        return this.archiveNeverPublished(actorUserId, input);
      }
      const result = await this.publisher.publish({
        actorUserId,
        expectedRevision: input.expectedRevision,
        invalidationScopes: ['skill-catalog', 'skill-runtime'],
        payload: {},
        pointer: this.createPointer({
          actorUserId,
          builtinOverrideTombstone: skill.allowBuiltinOverride,
          expectedDraftToken: input.expectedDraftToken,
          skillId: input.id,
          versionId: skill.currentVersionId,
        }),
        reason: input.reason,
        resourceId: input.id,
        resourceType: 'skill',
        status: 'archived',
      });
      invalidatePublishedSkillCatalogReadCache();
      return {
        auditId: result.auditId,
        catalogRevision: catalogRevision(input.id, result.revision.revision),
        revision: result.revision.revision,
        skillId: input.id,
        status: 'archived' as const,
        versionId: skill.currentVersionId,
      };
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.skills.archive',
        actorUserId,
        reason: input.reason,
        targetId: input.id,
      });
      throw error;
    }
  };

  rollback = async (actorUserId: string, input: RollbackSkillInput) => {
    try {
      const repository = new PlatformSkillCatalogRepository(this.db);
      const targetRevision = await repository.getPublishedRevisionForVersion(
        input.id,
        input.targetVersionId,
      );
      if (!targetRevision) throw new SkillCatalogNotFoundError();
      const result = await this.publisher.rollback({
        actorUserId,
        expectedRevision: input.expectedRevision,
        invalidationScopes: ['skill-catalog', 'skill-runtime'],
        pointer: this.createPointer({
          actorUserId,
          expectedDraftToken: input.expectedDraftToken,
          skillId: input.id,
          validateVersion: true,
          versionId: input.targetVersionId,
        }),
        reason: input.reason,
        resourceId: input.id,
        resourceType: 'skill',
        targetRevision,
      });
      invalidatePublishedSkillCatalogReadCache();
      return {
        auditId: result.auditId,
        catalogRevision: catalogRevision(input.id, result.revision.revision),
        revision: result.revision.revision,
        skillId: input.id,
        status: 'published' as const,
        versionId: input.targetVersionId,
      };
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.skills.rollback',
        actorUserId,
        reason: input.reason,
        targetId: input.id,
      });
      throw error;
    }
  };
}
