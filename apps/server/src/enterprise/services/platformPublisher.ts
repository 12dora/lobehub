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
    const { invalidationScopes, ...publishParams } = params;
    const result = await this.revisions.publishDraft(publishParams);

    await this.invalidation.publish({
      at: new Date().toISOString(),
      resourceId: params.resourceId,
      resourceType: params.resourceType,
      revision: result.revision.revision,
      scopes: invalidationScopes ?? [params.resourceType],
    });

    return result;
  };

  rollback = async (params: RollbackResourceParams): Promise<PublishResult> => {
    const { invalidationScopes, ...rollbackParams } = params;
    const result = await this.revisions.rollbackToRevision(rollbackParams);

    await this.invalidation.publish({
      at: new Date().toISOString(),
      resourceId: params.resourceId,
      resourceType: params.resourceType,
      revision: result.revision.revision,
      scopes: invalidationScopes ?? [params.resourceType],
    });

    return result;
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
