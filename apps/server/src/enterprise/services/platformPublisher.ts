import {
  type PlatformResourceType,
  PlatformRevisionConflictError,
  PlatformRevisionImmutableError,
  PlatformRevisionModel,
  type PublishDraftParams,
  type PublishResult,
  type RollbackToRevisionParams,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import { classifyEnterpriseError, observeEnterprisePlatformEvent } from '../observability';
import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from './platformConfigInvalidation';

export { PlatformRevisionConflictError, PlatformRevisionImmutableError };

export type PublishResourceParams = PublishDraftParams & {
  /** Optional scopes to invalidate after publish (e.g. `branding`, `settings`). */
  invalidationScopes?: string[];
};

export type RollbackResourceParams = RollbackToRevisionParams & {
  invalidationScopes?: string[];
};

const observabilityDomain = (resourceType: PlatformResourceType) => {
  switch (resourceType) {
    case 'agent': {
      return 'agent_catalog' as const;
    }
    case 'branding': {
      return 'branding' as const;
    }
    case 'connector': {
      return 'connector_catalog' as const;
    }
    case 'managed_policy': {
      return 'managed_resource' as const;
    }
    case 'model':
    case 'provider': {
      return 'ai_catalog' as const;
    }
    case 'settings': {
      return 'settings' as const;
    }
    case 'skill': {
      return 'skill_catalog' as const;
    }
    default: {
      return 'unknown' as const;
    }
  }
};

/**
 * Public platform publish service.
 *
 * Coordinates the atomic Revision publish transaction (validate expectedRevision →
 * write Revision → update pointer → write Audit) and then best-effort emits a
 * config invalidation event so multi-instance caches can drop stale snapshots.
 *
 * Does not mount any tRPC routes — that is owned by M00/M02.
 */
export class PlatformPublisherService {
  private readonly revisions: PlatformRevisionModel;
  private readonly invalidation: PlatformConfigInvalidationPublisher;

  constructor(
    db: LobeChatDatabase,
    invalidation: PlatformConfigInvalidationPublisher = getPlatformConfigInvalidationPublisher(),
  ) {
    this.revisions = new PlatformRevisionModel(db);
    this.invalidation = invalidation;
  }

  publish = async (params: PublishResourceParams): Promise<PublishResult> => {
    const startedAt = Date.now();
    try {
      const { invalidationScopes, ...publishParams } = params;
      const result = await this.revisions.publishDraft(publishParams);

      await this.publishInvalidation({
        at: new Date().toISOString(),
        resourceId: params.resourceId,
        resourceType: params.resourceType,
        revision: result.revision.revision,
        scopes: invalidationScopes ?? [params.resourceType],
      });

      observeEnterprisePlatformEvent({
        domain: observabilityDomain(params.resourceType),
        durationMs: Date.now() - startedAt,
        operation: 'publish',
        outcome: 'success',
        type: 'config_publish',
      });
      return result;
    } catch (error) {
      observeEnterprisePlatformEvent({
        domain: observabilityDomain(params.resourceType),
        durationMs: Date.now() - startedAt,
        errorClass: classifyEnterpriseError(error),
        operation: 'publish',
        outcome: error instanceof PlatformRevisionConflictError ? 'conflict' : 'failure',
        type: 'config_publish',
      });
      throw error;
    }
  };

  rollback = async (params: RollbackResourceParams): Promise<PublishResult> => {
    const startedAt = Date.now();
    try {
      const { invalidationScopes, ...rollbackParams } = params;
      const result = await this.revisions.rollbackToRevision(rollbackParams);

      await this.publishInvalidation({
        at: new Date().toISOString(),
        resourceId: params.resourceId,
        resourceType: params.resourceType,
        revision: result.revision.revision,
        scopes: invalidationScopes ?? [params.resourceType],
      });

      observeEnterprisePlatformEvent({
        domain: observabilityDomain(params.resourceType),
        durationMs: Date.now() - startedAt,
        operation: 'rollback',
        outcome: 'success',
        type: 'config_publish',
      });
      return result;
    } catch (error) {
      observeEnterprisePlatformEvent({
        domain: observabilityDomain(params.resourceType),
        durationMs: Date.now() - startedAt,
        errorClass: classifyEnterpriseError(error),
        operation: 'rollback',
        outcome: error instanceof PlatformRevisionConflictError ? 'conflict' : 'failure',
        type: 'config_publish',
      });
      throw error;
    }
  };

  private publishInvalidation = async (
    event: Parameters<PlatformConfigInvalidationPublisher['publish']>[0],
  ): Promise<void> => {
    try {
      await this.invalidation.publish(event);
    } catch (error) {
      // The database revision is already committed. Cache invalidation is recoverable
      // from the DB/version probes and must never turn a committed publish into failure.
      console.error('[platformPublisher] invalidation delivery failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
        resourceType: event.resourceType,
        revision: event.revision,
      });
    }
  };

  getPublishedSnapshot = async (resourceType: PlatformResourceType, resourceId: string) => {
    return this.revisions.getPublishedSnapshot(resourceType, resourceId);
  };

  listRevisions = async (
    resourceType: PlatformResourceType,
    resourceId: string,
    limit?: number,
  ) => {
    return this.revisions.listRevisions(resourceType, resourceId, limit);
  };
}
