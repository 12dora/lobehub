/**
 * Org-wide connector governance (M-parity follow-up):
 * - a builtin in-process tool permission matrix that REPLACES per-user
 *   connector_tools permissions while the connectors managed policy is
 *   effectively enforced, and
 * - a designated shared OAuth identity so every user shares one authorization
 *   (LobeHub market trusted identity, Composio entity, platform per-user-OAuth
 *   binding) while managed.
 *
 * User rows are never mutated by governance: switching managed off restores
 * per-user behavior wholesale (shadowing, not migration).
 *
 * The persisted document shape lives in `@lobechat/types` (shared with the
 * database schema layer); this module remains the source runtime consumers
 * import from.
 */
import type { ConnectorBuiltinToolPolicyMap } from '@/types/platform/connectorGovernance';

export type {
  ConnectorBuiltinToolPolicyMap,
  ConnectorGovernanceDoc,
  ConnectorGovernancePermission,
  ConnectorSharedAuthorization,
} from '@/types/platform/connectorGovernance';
export { emptyConnectorGovernanceDoc } from '@/types/platform/connectorGovernance';

export interface ResolvedConnectorGovernance {
  /**
   * true only when the connectors managed-resource policy is effectively
   * `managed && enforcementMode === 'enforced'` (feature flag + readiness
   * included). When false, runtime behavior is exactly the per-user default.
   */
  active: boolean;
  builtinToolPolicies: ConnectorBuiltinToolPolicyMap;
  /** Non-null only when active and a shared identity has been designated. */
  sharedAuthOwnerUserId: string | null;
}

export const EMPTY_CONNECTOR_GOVERNANCE: ResolvedConnectorGovernance = {
  active: false,
  builtinToolPolicies: {},
  sharedAuthOwnerUserId: null,
};
