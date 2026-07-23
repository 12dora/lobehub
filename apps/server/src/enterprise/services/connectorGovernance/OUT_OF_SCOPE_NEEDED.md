# OUT\_OF\_SCOPE\_NEEDED — connector governance

## CRITICAL — upstream consumer gap (cannot close inside 二开 alone)

**Location:** `apps/server/src/services/toolExecution/index.ts`, `apps/server/src/services/toolExecution/builtin.ts`, `apps/server/src/services/aiAgent/index.ts`

**Gap:** Upstream governance consumers do **not** honor any fail-closed sentinel. They only:

1. Block a builtin when `governance.active && builtinToolPolicies[id][api] === 'disabled'`
2. Fall back to the **manifest default** on matrix miss (`?? null` → allow path)
3. Use shared auth only when `active && sharedAuthOwnerUserId` is non-null; otherwise per-user

They ignore any `unavailable` (or similar) field. This slice therefore synthesizes a deny-all matrix from `@lobechat/builtin-tools` plus a synthetic shared-auth owner.

**Remaining holes that require upstream changes:**

| Hole                                                                                          | Why 二开 cannot close it                                                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Builtin APIs only present via dynamic `resolveManifest` and absent from static `manifest.api` | Deny-all matrix is built from the static registry; matrix miss still allows at the execution gate |
| Non-builtin identifiers (MCP / Skills / Composio) while `active`                              | Upstream keeps the per-user permission path for non-builtins; org matrix never applies            |
| True “unknown policy” distinct from “deny all”                                                | Upstream has no typed fail-closed outcome; only inactive (fail-open) vs matrix values             |

**Required upstream fix (for a complete close):** Treat governance resolve failure as a first-class denied outcome — e.g. hard-block all governed paths when resolve fails, or honor a contract field — rather than matrix-miss / inactive fallback. Until then, the deny-all approximation is the strongest fail-closed shape the existing consumers enforce.
