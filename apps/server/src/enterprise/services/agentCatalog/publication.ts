import debug from 'debug';

import { checksumPayload } from '@/database/models/platform/checksum';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  AdminPlatformAgentPublishInput,
  AdminPlatformAgentRollbackInput,
} from '../../contracts/platformAgents';
import { PlatformAuditService } from '../platformAudit';
import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { assertExactPlatformAgentDependencies } from './dependencyValidator';
import { PlatformAgentNotFoundError, PlatformAgentRevisionConflictError } from './errors';

const log = debug('lobe-server:platform-agent-publication');

export interface PlatformAgentPublicationLifecycle {
  afterDependencyLock?: (tx: Transaction) => Promise<void>;
  afterIdentityLock?: (tx: Transaction) => Promise<void>;
}

export interface PlatformAgentPublicationOptions {
  invalidation?: PlatformConfigInvalidationPublisher;
  lifecycle?: PlatformAgentPublicationLifecycle;
  validateDependencies?: typeof assertExactPlatformAgentDependencies;
}

interface AgentDraftTokenInput {
  agentKey: string;
  currentVersionId: string | null;
  draftSequence: number;
  id: string;
  isDefault: boolean;
  migrationRequired: boolean;
  revision: number;
  status: string;
  systemKey: string | null;
}

export const platformAgentDraftToken = (identity: AgentDraftTokenInput): string =>
  checksumPayload({
    agentKey: identity.agentKey,
    currentVersionId: identity.currentVersionId,
    draftSequence: identity.draftSequence,
    id: identity.id,
    isDefault: identity.isDefault,
    migrationRequired: identity.migrationRequired,
    revision: identity.revision,
    status: identity.status,
    systemKey: identity.systemKey,
  });

export const assertExpectedPlatformAgentIdentity = (
  identity: AgentDraftTokenInput,
  expectedDraftToken: string,
  expectedRevision: number,
) => {
  if (
    identity.migrationRequired ||
    identity.revision !== expectedRevision ||
    platformAgentDraftToken(identity) !== expectedDraftToken
  ) {
    throw new PlatformAgentRevisionConflictError();
  }
};

export class PlatformAgentPublicationService {
  private readonly invalidation: PlatformConfigInvalidationPublisher;
  private readonly lifecycle: PlatformAgentPublicationLifecycle;
  private readonly validateDependencies: typeof assertExactPlatformAgentDependencies;

  constructor(
    private readonly db: LobeChatDatabase,
    options: PlatformAgentPublicationOptions = {},
  ) {
    this.invalidation = options.invalidation ?? getPlatformConfigInvalidationPublisher();
    this.lifecycle = options.lifecycle ?? {};
    this.validateDependencies =
      options.validateDependencies ?? assertExactPlatformAgentDependencies;
  }

  private invalidate = async (agentId: string, revision: number): Promise<void> => {
    try {
      await this.invalidation.publish({
        at: new Date().toISOString(),
        resourceId: agentId,
        resourceType: 'agent',
        revision,
        scopes: ['agent-catalog', 'agent-runtime'],
      });
    } catch (error) {
      log(
        'post-commit invalidation failed agent=%s revision=%d class=%s',
        agentId,
        revision,
        error instanceof Error ? error.name : 'UnknownError',
      );
    }
  };

  private appendFailureAudit = async (params: {
    action: string;
    actorUserId: string;
    reason: string;
    targetId: string;
  }): Promise<void> => {
    try {
      await new PlatformAuditService(this.db).append({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: { error: 'platform_agent_publication_failed' },
        reason: params.reason,
        result: 'failure',
        targetId: params.targetId,
        targetType: 'agent',
      });
    } catch (error) {
      log(
        'failure audit append failed agent=%s class=%s',
        params.targetId,
        error instanceof Error ? error.name : 'UnknownError',
      );
    }
  };

  publish = async (actorUserId: string, input: AdminPlatformAgentPublishInput) => {
    try {
      const result = await this.db.transaction(async (tx) => {
        const repository = new PlatformAgentCatalogRepository(tx);
        const locked = await repository.lockIdentity(input.agentId);
        if (!locked) throw new PlatformAgentNotFoundError();
        await this.lifecycle.afterIdentityLock?.(tx);
        assertExpectedPlatformAgentIdentity(
          locked,
          input.expectedDraftToken,
          input.expectedRevision,
        );

        await acquirePlatformDependencyPublicationLock(tx);
        await this.lifecycle.afterDependencyLock?.(tx);
        const version = await repository.getExactVersion(locked.id, input.versionId);
        if (!version) throw new PlatformAgentNotFoundError();
        await this.validateDependencies(tx, version.dependencySnapshot);
        const identity = await repository.pointToVersionCas({
          agentId: locked.id,
          expectedDraftSequence: locked.draftSequence,
          expectedRevision: locked.revision,
          publishedAt: new Date(),
          versionId: version.id,
        });
        if (!identity) throw new PlatformAgentRevisionConflictError();

        await new PlatformAuditService(tx).append({
          action: 'admin.agents.publish',
          actorUserId,
          afterDiff: {
            dependencyCounts: {
              connectors: version.dependencySnapshot.connectors.length,
              skills: version.dependencySnapshot.skills.length,
            },
            revision: identity.revision,
            version: version.version,
            versionChecksum: version.checksum,
            versionId: version.id,
          },
          beforeDiff: {
            currentVersionId: locked.currentVersionId,
            revision: locked.revision,
          },
          configRevision: identity.revision,
          reason: input.reason,
          result: 'success',
          targetId: locked.id,
          targetType: 'agent',
        });
        return { agentId: locked.id, revision: identity.revision, versionId: version.id };
      });
      await this.invalidate(result.agentId, result.revision);
      return result;
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.agents.publish',
        actorUserId,
        reason: input.reason,
        targetId: input.agentId,
      });
      throw error;
    }
  };

  rollback = async (actorUserId: string, input: AdminPlatformAgentRollbackInput) => {
    try {
      const result = await this.db.transaction(async (tx) => {
        const repository = new PlatformAgentCatalogRepository(tx);
        const locked = await repository.lockIdentity(input.agentId);
        if (!locked) throw new PlatformAgentNotFoundError();
        await this.lifecycle.afterIdentityLock?.(tx);
        assertExpectedPlatformAgentIdentity(
          locked,
          input.expectedDraftToken,
          input.expectedRevision,
        );

        await acquirePlatformDependencyPublicationLock(tx);
        await this.lifecycle.afterDependencyLock?.(tx);
        const target = await repository.getExactVersion(locked.id, input.targetVersionId);
        if (!target) throw new PlatformAgentNotFoundError();
        await this.validateDependencies(tx, target.dependencySnapshot);

        const identity = await repository.pointToVersionCas({
          agentId: locked.id,
          expectedDraftSequence: locked.draftSequence,
          expectedRevision: locked.revision,
          publishedAt: new Date(),
          versionId: target.id,
        });
        if (!identity) throw new PlatformAgentRevisionConflictError();
        await new PlatformAuditService(tx).append({
          action: 'admin.agents.rollback',
          actorUserId,
          afterDiff: {
            revision: identity.revision,
            version: target.version,
            versionChecksum: target.checksum,
            versionId: target.id,
          },
          beforeDiff: {
            currentVersionId: locked.currentVersionId,
            revision: locked.revision,
          },
          configRevision: identity.revision,
          reason: input.reason,
          result: 'success',
          targetId: locked.id,
          targetType: 'agent',
        });
        return { agentId: locked.id, revision: identity.revision, versionId: target.id };
      });
      await this.invalidate(result.agentId, result.revision);
      return result;
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.agents.rollback',
        actorUserId,
        reason: input.reason,
        targetId: input.agentId,
      });
      throw error;
    }
  };
}
