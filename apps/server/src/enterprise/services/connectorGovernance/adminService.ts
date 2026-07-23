import debug from 'debug';
import { eq } from 'drizzle-orm';

import {
  PlatformConnectorGovernanceModel,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import {
  CONNECTOR_GOVERNANCE_RESOURCE_ID,
  CONNECTOR_GOVERNANCE_RESOURCE_TYPE,
} from '@/types/platform/connectorGovernance';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { PlatformAuditService } from '../platformAudit';
import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import { CONNECTOR_GOVERNANCE_INVALIDATION_SCOPE } from './service';
import type { ConnectorBuiltinToolPolicyMap, ConnectorGovernanceDoc } from './types';

const log = debug('lobe-server:connector-governance-admin');

/** Thrown when a designated shared-auth owner does not exist in the users table. */
export class ConnectorGovernanceOwnerNotFoundError extends Error {
  readonly code = 'PLATFORM_INVALID_INPUT' as const;

  constructor(public readonly ownerUserId: string) {
    super('Connector governance shared-authorization owner does not exist');
    this.name = 'ConnectorGovernanceOwnerNotFoundError';
  }
}

export interface ConnectorGovernanceAdminServiceOptions {
  env?: Record<string, string | undefined>;
  invalidation?: PlatformConfigInvalidationPublisher;
}

/**
 * Admin-facing org connector governance operations. Every mutation is
 * applyImmediate-style (write + publish in one shot under an optimistic
 * revision check), audited, and followed by a `connector-governance`
 * invalidation-scope bump so runtime resolvers drop their cache.
 */
export class ConnectorGovernanceAdminService {
  private readonly db: LobeChatDatabase;
  private readonly env: Record<string, string | undefined>;
  private readonly invalidation: PlatformConfigInvalidationPublisher;
  private readonly model: PlatformConnectorGovernanceModel;

  constructor(db: LobeChatDatabase, options: ConnectorGovernanceAdminServiceOptions = {}) {
    this.db = db;
    this.env = options.env ?? process.env;
    this.invalidation = options.invalidation ?? getPlatformConfigInvalidationPublisher();
    this.model = new PlatformConnectorGovernanceModel(db);
  }

  get = async (): Promise<{
    doc: ConnectorGovernanceDoc;
    managedActive: boolean;
    revision: number;
  }> => {
    const [snapshot, policySnapshot] = await Promise.all([
      this.model.getOrCreate(),
      new PlatformManagedResourcePolicyModel(this.db).getSnapshot(),
    ]);
    const flags = parseEnterpriseFeatureFlags(this.env);
    const policy = policySnapshot.published.connectors;
    const managedActive =
      flags.ENABLE_PLATFORM_MANAGED_CONNECTORS &&
      policySnapshot.status === 'published' &&
      policy.managed &&
      policy.enforcementMode === 'enforced';
    return { doc: snapshot.published, managedActive, revision: snapshot.revision };
  };

  updateBuiltinToolPolicy = async (params: {
    actorUserId: string;
    expectedRevision: number;
    policies: ConnectorBuiltinToolPolicyMap;
    reason: string;
  }): Promise<{ revision: number }> => {
    const current = await this.model.getOrCreate();
    return this.publish({
      action: 'admin.connectors.updateBuiltinToolPolicy',
      actorUserId: params.actorUserId,
      before: current.published,
      doc: {
        builtinToolPolicies: params.policies,
        sharedAuthorization: current.published.sharedAuthorization,
      },
      expectedRevision: params.expectedRevision,
      reason: params.reason,
    });
  };

  setSharedAuthorization = async (params: {
    actorUserId: string;
    expectedRevision: number;
    ownerUserId: string | null;
    reason: string;
  }): Promise<{ revision: number }> => {
    if (params.ownerUserId !== null) {
      const [owner] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, params.ownerUserId))
        .limit(1);
      if (!owner) throw new ConnectorGovernanceOwnerNotFoundError(params.ownerUserId);
    }
    const current = await this.model.getOrCreate();
    return this.publish({
      action: 'admin.connectors.setSharedAuthorization',
      actorUserId: params.actorUserId,
      before: current.published,
      doc: {
        builtinToolPolicies: current.published.builtinToolPolicies,
        sharedAuthorization: { ownerUserId: params.ownerUserId },
      },
      expectedRevision: params.expectedRevision,
      reason: params.reason,
    });
  };

  private publish = async (params: {
    action: string;
    actorUserId: string;
    before: ConnectorGovernanceDoc;
    doc: ConnectorGovernanceDoc;
    expectedRevision: number;
    reason: string;
  }): Promise<{ revision: number }> => {
    // Mutation + success audit are one transaction: either both commit or neither.
    // Invalidation remains post-commit best-effort (never reclassifies success).
    let revision: number;
    try {
      revision = await this.db.transaction(async (tx) => {
        const model = new PlatformConnectorGovernanceModel(tx);
        const published = await model.publishGovernance({
          doc: params.doc,
          expectedRevision: params.expectedRevision,
          updatedBy: params.actorUserId,
        });
        await new PlatformAuditService(tx).append({
          action: params.action,
          actorUserId: params.actorUserId,
          afterDiff: { doc: params.doc },
          beforeDiff: { doc: params.before },
          configRevision: published.revision,
          reason: params.reason,
          result: 'success',
          targetId: CONNECTOR_GOVERNANCE_RESOURCE_ID,
          targetType: CONNECTOR_GOVERNANCE_RESOURCE_TYPE,
        });
        return published.revision;
      });
    } catch (error) {
      await this.appendFailureAudit(params);
      throw error;
    }

    // Best-effort by design: publisher failures degrade to TTL-bounded caches.
    try {
      await this.invalidation.publish({
        at: new Date().toISOString(),
        resourceId: CONNECTOR_GOVERNANCE_RESOURCE_ID,
        resourceType: CONNECTOR_GOVERNANCE_RESOURCE_TYPE,
        revision,
        scopes: [CONNECTOR_GOVERNANCE_INVALIDATION_SCOPE],
      });
    } catch (invalidationError) {
      log(
        'invalidation publish failed after commit errorClass=%s',
        invalidationError instanceof Error ? invalidationError.name : 'UnknownError',
      );
    }
    return { revision };
  };

  private appendFailureAudit = async (params: {
    action: string;
    actorUserId: string;
    reason: string;
  }): Promise<void> => {
    try {
      await new PlatformAuditService(this.db).append({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: { error: 'operation_failed' },
        beforeDiff: null,
        reason: params.reason,
        result: 'failure',
        targetId: CONNECTOR_GOVERNANCE_RESOURCE_ID,
        targetType: CONNECTOR_GOVERNANCE_RESOURCE_TYPE,
      });
    } catch (auditError) {
      log(
        'failure audit append failed errorClass=%s',
        auditError instanceof Error ? auditError.name : 'UnknownError',
      );
    }
  };
}
