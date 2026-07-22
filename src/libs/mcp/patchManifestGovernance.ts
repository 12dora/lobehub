/**
 * Org-mandate layer for builtin in-process tool manifests.
 *
 * While the org connectors managed policy is effectively enforced
 * (`governance.active`), the org's builtin tool permission matrix REPLACES
 * per-user connector_tools rows for builtin identifiers. This helper surfaces
 * the matrix to the model / approval prompt by patching manifest `api[]`
 * entries, mirroring the per-user semantics of `patchManifestPermissions.ts`
 * and `buildConnectorManifests.ts`:
 *
 * - 'disabled'       → blocking description + humanIntervention 'required'
 *                      (the hard block is enforced separately at execution
 *                      time in ToolExecutionService)
 * - 'needs_approval' → humanIntervention 'required'
 * - 'auto'           → the org explicitly allows the API: strip ONLY a static
 *                      `'required'` the manifest shipped with; `'always'` and
 *                      rule/dynamic intervention configs are tool-authored
 *                      safety gates (not permission defaults) and stay as-is
 * - matrix miss      → the manifest's static default behavior, same as an
 *                      unsynced user today
 *
 * Pure (no DB / server imports) so it can run wherever the manifests are
 * built. The permission strings are structurally identical to
 * `ConnectorGovernancePermission` in the enterprise connector governance
 * service; they are re-declared here to keep this module dependency-free.
 */

export type BuiltinGovernancePermission = 'auto' | 'disabled' | 'needs_approval';

/** identifier (builtin tool id, e.g. `lobe-task`) → apiName → permission. */
export type BuiltinGovernanceMatrix = Record<string, Record<string, BuiltinGovernancePermission>>;

export function patchBuiltinManifestWithGovernance<
  M extends {
    api: Array<{
      description?: string;
      humanIntervention?: unknown;
      name: string;
      [k: string]: unknown;
    }>;
    identifier: string;
  },
>(manifest: M, matrix: BuiltinGovernanceMatrix): M {
  const policies = matrix[manifest.identifier];
  if (!policies || !Array.isArray(manifest.api)) return manifest;

  const patchedApi = manifest.api.map((api) => {
    const permission = policies[api.name];
    if (permission === 'disabled') {
      return {
        ...api,
        description:
          `[TOOL DISABLED] This tool has been disabled by your organization's connector policy ` +
          `and cannot be executed. Do NOT call this tool. If the user asks to perform this action, ` +
          `inform them that "${api.name}" is disabled by organization policy and only an ` +
          `administrator can re-enable it.`,
        humanIntervention: 'required' as const,
      };
    }
    if (permission === 'needs_approval') {
      return { ...api, humanIntervention: 'required' as const };
    }
    if (permission === 'auto' && api.humanIntervention === 'required') {
      // The org explicitly allows this API: drop only the static 'required'
      // approval gate. 'always' / complex configs remain safety-critical.
      return { ...api, humanIntervention: undefined };
    }
    return api;
  });
  return { ...manifest, api: patchedApi };
}
