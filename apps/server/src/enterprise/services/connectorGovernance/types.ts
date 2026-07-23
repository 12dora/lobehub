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
import { builtinTools } from '@lobechat/builtin-tools';

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

/** Per-user default when managed connectors are intentionally inactive. */
export const EMPTY_CONNECTOR_GOVERNANCE: ResolvedConnectorGovernance = {
  active: false,
  builtinToolPolicies: {},
  sharedAuthOwnerUserId: null,
};

/**
 * Synthetic shared-auth owner used only on unresolvable governance failure.
 * Upstream substitutes this identity when `active && sharedAuthOwnerUserId`
 * is set, which prevents falling back to the calling user's bindings. The
 * sentinel is not a real user; Skill/Composio lookups resolve empty.
 */
export const CONNECTOR_GOVERNANCE_DENY_SHARED_OWNER = 'platform:connector-governance:deny';

/**
 * Build a matrix that marks every registered builtin API as `disabled` — the
 * same permission value ToolExecutionService already hard-blocks.
 */
export const buildDenyAllBuiltinToolPolicies = (): ConnectorBuiltinToolPolicyMap => {
  const policies: ConnectorBuiltinToolPolicyMap = {};
  for (const tool of builtinTools) {
    const apis = tool.manifest?.api ?? [];
    if (apis.length === 0) continue;
    policies[tool.identifier] = Object.fromEntries(
      apis.map((api) => [api.name, 'disabled' as const]),
    );
  }
  return policies;
};

/**
 * Fail-closed representation when a governance read fails and no trustworthy
 * LKG exists. Uses only shapes upstream already enforces:
 * - `active: true` takes the org path (no per-user builtin rows)
 * - every known builtin API is `disabled` (execution gate blocks)
 * - non-null sharedAuthOwnerUserId forces shared-auth substitution (no
 *   per-user market/composio fallback)
 *
 * Do NOT use a custom `unavailable` flag — upstream consumers ignore it and
 * fall through to defaults.
 */
export const DENIED_CONNECTOR_GOVERNANCE: ResolvedConnectorGovernance = {
  active: true,
  builtinToolPolicies: buildDenyAllBuiltinToolPolicies(),
  sharedAuthOwnerUserId: CONNECTOR_GOVERNANCE_DENY_SHARED_OWNER,
};

/** @deprecated Prefer DENIED_CONNECTOR_GOVERNANCE — kept for import stability. */
export const UNAVAILABLE_CONNECTOR_GOVERNANCE = DENIED_CONNECTOR_GOVERNANCE;
