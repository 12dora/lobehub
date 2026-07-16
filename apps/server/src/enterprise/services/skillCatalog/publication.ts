import {
  createPlatformSkillPointerAdapter,
  type ResourcePointerAdapter,
} from '@/database/models/platform';
import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformAuditService } from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { PlatformPublisherService } from '../platformPublisher';
import { SkillCatalogNotFoundError, SkillCatalogValidationError } from './errors';
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

  archive = async (actorUserId: string, input: PublicationInput) => {
    try {
      const skill = await new PlatformSkillCatalogRepository(this.db).getSkill(input.id);
      if (!skill?.currentVersionId) throw new SkillCatalogNotFoundError();
      const result = await this.publisher.publish({
        actorUserId,
        expectedRevision: input.expectedRevision,
        invalidationScopes: ['skill-catalog', 'skill-runtime'],
        payload: {},
        pointer: this.createPointer({
          actorUserId,
          expectedDraftToken: input.expectedDraftToken,
          skillId: input.id,
          versionId: skill.currentVersionId,
        }),
        reason: input.reason,
        resourceId: input.id,
        resourceType: 'skill',
        status: 'archived',
      });
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
