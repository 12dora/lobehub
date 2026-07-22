import { eq } from 'drizzle-orm';

import {
  CONNECTOR_GOVERNANCE_RESOURCE_ID,
  type ConnectorBuiltinToolPolicyMap,
  type ConnectorGovernanceDoc,
  type ConnectorGovernancePermission,
  emptyConnectorGovernanceDoc,
} from '@/types/platform/connectorGovernance';

import { platformConnectorGovernance } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformRevisionConflictError } from './errors';

const CONNECTOR_GOVERNANCE_PERMISSIONS: readonly ConnectorGovernancePermission[] = [
  'auto',
  'disabled',
  'needs_approval',
];

const normalizeBuiltinToolPolicies = (value: unknown): ConnectorBuiltinToolPolicyMap => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: ConnectorBuiltinToolPolicyMap = {};
  for (const [identifier, tools] of Object.entries(value as Record<string, unknown>)) {
    if (!identifier || !tools || typeof tools !== 'object' || Array.isArray(tools)) continue;
    const normalizedTools: Record<string, ConnectorGovernancePermission> = {};
    for (const [toolName, permission] of Object.entries(tools as Record<string, unknown>)) {
      if (!toolName) continue;
      if (!CONNECTOR_GOVERNANCE_PERMISSIONS.includes(permission as ConnectorGovernancePermission)) {
        continue;
      }
      normalizedTools[toolName] = permission as ConnectorGovernancePermission;
    }
    normalized[identifier] = normalizedTools;
  }
  return normalized;
};

/** Close legacy `{}` / malformed rows to a well-formed governance doc. */
export const normalizeConnectorGovernanceDoc = (value: unknown): ConnectorGovernanceDoc => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyConnectorGovernanceDoc();
  }
  const candidate = value as Partial<ConnectorGovernanceDoc>;
  const rawOwner = candidate.sharedAuthorization?.ownerUserId;
  return {
    builtinToolPolicies: normalizeBuiltinToolPolicies(candidate.builtinToolPolicies),
    sharedAuthorization: {
      ownerUserId: typeof rawOwner === 'string' && rawOwner.length > 0 ? rawOwner : null,
    },
  };
};

export interface ConnectorGovernanceSnapshot {
  draft: ConnectorGovernanceDoc;
  published: ConnectorGovernanceDoc;
  revision: number;
}

/**
 * Single-logical-row repository for the `governance:connectors` document.
 * Publish is applyImmediate-style: draft and published are always written
 * together under an optimistic revision check.
 */
export class PlatformConnectorGovernanceModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  private ensureRow = async (): Promise<void> => {
    await this.db
      .insert(platformConnectorGovernance)
      .values({
        config: { draft: emptyConnectorGovernanceDoc(), published: emptyConnectorGovernanceDoc() },
        resource: CONNECTOR_GOVERNANCE_RESOURCE_ID,
        revision: 0,
      })
      .onConflictDoNothing({ target: platformConnectorGovernance.resource });
  };

  /** Read the governance row, creating it (and normalizing legacy shapes) when absent. */
  getOrCreate = async (): Promise<ConnectorGovernanceSnapshot> => {
    await this.ensureRow();
    const [row] = await this.db
      .select()
      .from(platformConnectorGovernance)
      .where(eq(platformConnectorGovernance.resource, CONNECTOR_GOVERNANCE_RESOURCE_ID))
      .limit(1);
    if (!row) throw new Error('Connector governance row missing after ensure');
    return {
      draft: normalizeConnectorGovernanceDoc(row.config?.draft),
      published: normalizeConnectorGovernanceDoc(row.config?.published),
      revision: row.revision,
    };
  };

  /**
   * Replace + publish the governance doc in one shot with an optimistic
   * revision check. Mismatch throws `PlatformRevisionConflictError`, which
   * routers map to a PLATFORM_REVISION_CONFLICT conflict response.
   */
  publishGovernance = async (params: {
    doc: ConnectorGovernanceDoc;
    expectedRevision: number;
    updatedBy?: string | null;
  }): Promise<{ revision: number }> => {
    await this.ensureRow();
    const doc = normalizeConnectorGovernanceDoc(params.doc);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          revision: platformConnectorGovernance.revision,
        })
        .from(platformConnectorGovernance)
        .where(eq(platformConnectorGovernance.resource, CONNECTOR_GOVERNANCE_RESOURCE_ID))
        .limit(1)
        .for('update');
      if (!row) throw new Error('Connector governance row missing after ensure');
      if (row.revision !== params.expectedRevision) {
        throw new PlatformRevisionConflictError(
          'Connector governance revision conflict: expectedRevision does not match current revision',
          {
            currentRevision: row.revision,
            expectedRevision: params.expectedRevision,
            resourceId: CONNECTOR_GOVERNANCE_RESOURCE_ID,
            resourceType: 'connector_governance',
          },
        );
      }
      const revision = row.revision + 1;
      await tx
        .update(platformConnectorGovernance)
        .set({
          config: { draft: doc, published: doc },
          revision,
          updatedAt: new Date(),
          updatedBy: params.updatedBy ?? null,
        })
        .where(eq(platformConnectorGovernance.resource, CONNECTOR_GOVERNANCE_RESOURCE_ID));
      return { revision };
    });
  };
}
