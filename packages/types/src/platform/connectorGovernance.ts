/**
 * Org-wide connector governance (M-parity follow-up):
 * - a builtin in-process tool permission matrix that REPLACES per-user
 *   connector_tools permissions while the connectors managed policy is
 *   effectively enforced, and
 * - a designated shared OAuth identity so every user shares one authorization
 *   while managed.
 *
 * User rows are never mutated by governance: switching managed off restores
 * per-user behavior wholesale (shadowing, not migration).
 */

export type ConnectorGovernancePermission = 'auto' | 'disabled' | 'needs_approval';

/** identifier (builtin tool id, e.g. `lobe-task`) → toolName → permission. */
export type ConnectorBuiltinToolPolicyMap = Record<
  string,
  Record<string, ConnectorGovernancePermission>
>;

export interface ConnectorSharedAuthorization {
  /**
   * User id whose OAuth identity is shared org-wide while connectors are
   * platform-managed. null = per-user authorization (default behavior).
   */
  ownerUserId: string | null;
}

/** Draft/published payload persisted for `governance:connectors`. */
export interface ConnectorGovernanceDoc {
  builtinToolPolicies: ConnectorBuiltinToolPolicyMap;
  sharedAuthorization: ConnectorSharedAuthorization;
}

/** JSONB contract persisted on the single governance row; draft is never read by runtime. */
export interface PlatformConnectorGovernanceConfig {
  draft: ConnectorGovernanceDoc;
  published: ConnectorGovernanceDoc;
}

export const CONNECTOR_GOVERNANCE_RESOURCE_ID = 'governance:connectors' as const;
export const CONNECTOR_GOVERNANCE_RESOURCE_TYPE = 'connector_governance' as const;

export const emptyConnectorGovernanceDoc = (): ConnectorGovernanceDoc => ({
  builtinToolPolicies: {},
  sharedAuthorization: { ownerUserId: null },
});
