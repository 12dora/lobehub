## Partition: shared-infra

Scope reviewed: Shared platform types/constants, business mount points, enterprise server infrastructure, client boot/providers/registry/navigation/routes/services, and admin primitives/gates/layout.
Files examined: 254 TypeScript/TSX files (\~15,912 lines), with repository-wide caller, route, localization, security-registry, and server-contract verification.

### Summary

The most serious risks are violations of the feature-flag default-off invariant: sidebar policy and multiple background jobs remain active when enterprise flags are disabled. The bootstrap “break-glass” administrator cannot actually authenticate, and dynamically registered admin routes can bypass the normal client-side admin gates. Business mount points contain substantial implementation logic despite the required one-line-only convention, substantially increasing coupling with the vendored upstream layer. Desktop router registrations are synchronized, no in-scope file exceeds 800 lines, and scoped translation keys are generally present; the main localization defect is persisted English system-role metadata overriding those translations.

### Findings

#### \[HIGH] Sidebar policy changes behavior while enterprise flags are off

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/hooks/useSidebarLayoutPolicy.ts:17`
- **Problem:** The hook always requests and applies the platform sidebar policy without checking whether the corresponding enterprise functionality is enabled.
- **Evidence:** `useClientDataSWR([SIDEBAR_LAYOUT_POLICY_KEY], () => fetchPlatformSidebarLayoutPolicy(), ...)` runs unconditionally and returns `data ?? DEFAULT_SIDEBAR_LAYOUT_POLICY`. Repository-wide callers include the normal home body, recents list, and agent/private dropdown menus. The matching server procedure also reads the persisted policy without a feature-flag guard.
- **Impact / failure scenario:** With every enterprise flag unset but a stale database policy of `mode: 'platform'`, ordinary users still issue the enterprise RPC and receive managed sidebar behavior, including hidden or constrained customization. A closed flag therefore changes both network activity and visible behavior.
- **Recommendation:** Gate the SWR key and policy application on the hydrated feature flag, return the user-controlled default while disabled, and make the server procedure return the disabled default as defense in depth. Add a regression test proving that all flags off results in zero policy RPCs and unchanged user layout.

#### \[HIGH] Audit workers start even when all enterprise flags are disabled

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/jobs/auditExport.ts:23`, `apps/server/src/enterprise/jobs/auditRetention.ts:23`
- **Problem:** Audit export and retention workers are controlled only by runtime/environment checks, not an enterprise feature flag.
- **Evidence:** Their predicates check production, Node runtime, hosting environment, and `DATABASE_URL`, then set `workerStarted = true` and immediately invoke `void run()`. The platform router calls both bootstrap functions during module initialization, and that router is mounted unconditionally.
- **Impact / failure scenario:** A self-hosted production deployment with a database but no enterprise flags still starts perpetual audit polling loops merely by importing the router. This violates the default-off invariant and generates unexpected database load and background mutations.
- **Recommendation:** Require an explicit audit/platform-admin flag before importing database dependencies or starting either loop, recheck the flag inside each batch, and add flag-off tests asserting no timers, polling, or database calls.

#### \[HIGH] Recurring jobs can start inside AWS Lambda request processes

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/jobs/agentRollout.ts:36`, `apps/server/src/enterprise/jobs/identityProviderTestAttemptCleanup.ts:45`
- **Problem:** These workers accept any Node runtime and omit the `AWS_LAMBDA_FUNCTION_NAME` serverless guard used by other jobs in the same package.
- **Evidence:** Both predicates check `NEXT_RUNTIME === 'nodejs'` and relevant flags, then perform immediate work and install recurring unref timers. Audit and secret-rewrap workers explicitly reject AWS Lambda, demonstrating the intended runtime distinction.
- **Impact / failure scenario:** Enabling managed agents or identity-provider testing on AWS Lambda starts a worker in every warm function container. Concurrent containers can perform duplicate cleanup or rollout work and continue database activity after request handling.
- **Recommendation:** Centralize the persistent-worker runtime predicate and apply the same Lambda/Vercel/serverless exclusions to every timer-based job. Move serverless execution to a durable scheduler or queue and add AWS Lambda regression cases for both workers.

#### \[HIGH] Bootstrap “break-glass” administrator has no login credential

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/bootstrap/superAdmin.ts:53`
- **Problem:** Bootstrap inserts a privileged user and role assignment but does not create a Better Auth credential account or password.
- **Evidence:** The insertion contains only user fields such as `emailVerified`, `id`, `role`, and `username`. The normal admin-user creation flow hashes a password and atomically creates an `accounts` row with `providerId: 'credential'`. `superAdmin.test.ts` verifies only the assigned role.
- **Impact / failure scenario:** During an identity-provider outage, `BOOTSTRAP_ALLOW_CREATE=1` reports that a break-glass super administrator was created, but the account cannot sign in. The recovery mechanism fails precisely during the outage it is intended to handle.
- **Recommendation:** Require or securely generate a one-time credential, hash it using the normal authentication flow, and create the user, credential account, and role assignment in one transaction. Add a regression test that authenticates the bootstrapped account through the real credential contract.

#### \[HIGH] Dynamically registered admin routes bypass the admin gate hierarchy

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/routes/index.ts:16`, `src/enterprise/client/registry.ts:7`
- **Problem:** Registry routes are appended as top-level siblings rather than children of the route tree protected by `AdminRootGate` and permission outlets.
- **Evidence:** The final route list is `[..., createAdminRouteTree(), ...enterpriseModuleRegistry.getRoutes()]`. The registry accepts arbitrary `RouteObject` entries and does not enforce an `/admin` parent, permission metadata, or a gate wrapper. The existing regression test registers `/admin/leak` and confirms it is matchable.
- **Impact / failure scenario:** A module registering an admin page at `/admin/leak` can render its component for a non-admin without passing through the standard client-side access and permission gates. Server middleware may protect subsequent RPCs, but client-only sensitive state and unauthorized UI can still be exposed.
- **Recommendation:** Register relative admin children with required permission metadata and inject them beneath the gated admin root. Reject absolute or out-of-admin module paths, and wrap every extension route with the same access and permission gates.

#### \[HIGH] New admin procedures are absent from the security registry contract

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/services/adminAiInfraAdapter/index.ts:295`, `src/enterprise/client/services/adminConnectors.ts:66`
- **Problem:** The scoped clients invoke `admin.aiProviders.getBatch` and `admin.connectors.getBatch`, but repository-wide verification finds neither procedure in the admin authorization registry. The second policy registry enumerates only mutations, so the required dual-registry invariant cannot currently cover these query procedures.
- **Evidence:** The service calls are `client.admin.aiProviders.getBatch.query(...)` and `client.admin.connectors.getBatch.query(...)`. Both server procedures exist and have direct permission middleware, but neither fully qualified path appears in the central authorization/policy registries.
- **Impact / failure scenario:** Registry-derived security reconciliation, permission inventories, and audit tooling omit live admin endpoints. A later middleware refactor can silently weaken these procedures because the central registry tests do not know they exist.
- **Recommendation:** Add both procedures to the authorization registry with their exact read permissions, extend the policy registry model to cover query procedures or formally split and enforce query/mutation registries, and derive reconciliation expectations from router paths rather than hard-coded counts.

#### \[HIGH] Business mount points contain substantial implementation logic

- **Dimension:** 1 / Code smells
- **Location:** `src/business/client/BusinessGlobalProvider.tsx:9`, `src/business/client/BusinessMobileRoutes.tsx:13`, `src/business/client/DefaultInboxBrandingSync.tsx:13`, `src/business/client/hooks/useHeteroAgentCloudConfig.ts:17`, `src/business/server/bot/featureAccess.ts:25`, `packages/business/config/src/llm.ts:5`, `packages/business/model-bank/src/model-config.ts:20`, `packages/business/model-runtime/src/model-mapping.ts:18`
- **Problem:** Mount-point files contain providers, effects, policy decisions, credential queries, routing logic, configuration generation, and model transformation instead of one-line registrations.
- **Evidence:** Of 104 `.ts/.tsx` files under the two business roots, 54 non-test files exceed three lines. Examples include a 40-line credential/configuration hook, a bot feature-access policy class, conditional route construction, and model mapping implementations.
- **Impact / failure scenario:** Enterprise behavior becomes embedded in the upstream override seam, increasing merge conflicts and making feature-off behavior difficult to audit. Sensitive cloud-credential and access-policy decisions are also hidden in files expected to be declarative mount points.
- **Recommendation:** Move every implementation into `src/enterprise` or an enterprise package and leave each business file as a single registration, re-export, or default binding line. Add a structural test that rejects multiline logic in both mount-point roots.

#### \[MEDIUM] Empty cursor pages remove the only way to navigate backward

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/primitives/DataTable.tsx:276`
- **Problem:** `DataTable` returns its empty state before rendering cursor controls, even when `hasPrevious` is true.
- **Evidence:** The early `if (rows.length === 0) return <Empty ... />` occurs before the cursor navigation block at lines 313–350. The cursor test covers only a non-empty result set.
- **Impact / failure scenario:** A user navigates to page two and deletes its final row, or a concurrent filter/change empties that page. The table renders only “empty,” removes Previous, and leaves the user trapped on an invalid cursor.
- **Recommendation:** Preserve cursor navigation when an empty page has a previous cursor, or automatically reset to the prior/first page. Add a regression test named `empty cursor page retains Previous`.

#### \[MEDIUM] Route regression test codifies the admin-gate bypass

- **Dimension:** 2 / Test rot
- **Location:** `src/enterprise/client/routes/flagOff.regression.test.ts:103`
- **Problem:** The test treats an arbitrary top-level `/admin/leak` registry route becoming matchable as correct flag-on behavior instead of verifying that it is protected by the admin gates.
- **Evidence:** After registering `/admin/leak`, the test concludes with `expect(matchRoutes(enterpriseRoutes, '/admin/leak')).toBeTruthy()`. It never renders the route as an anonymous, ordinary, or permission-limited user.
- **Impact / failure scenario:** The suite protects the insecure topology and will resist a correct fix that nests extension routes under `AdminRootGate`. It provides no regression coverage for the actual authorization boundary.
- **Recommendation:** Replace the match-only assertion with a sentinel route rendered through the real router and test anonymous, ordinary-user, insufficient-permission, and authorized-admin outcomes. Also add missing flag-off tests for sidebar policy and all auto-started audit workers.

#### \[MEDIUM] Persisted English system-role names override zh-CN translations

- **Dimension:** 4 / Missing simplified-Chinese (zh-CN) i18n
- **Location:** `packages/const/src/platform/roles.ts:21`
- **Problem:** Built-in role display names and descriptions are hardcoded in English and persisted as role metadata, while clients prefer that metadata over translated fallback labels.
- **Evidence:** Constants include `"Super Admin"`, `"User Admin"`, and English descriptions. The admin access UI renders `role.displayName || t(...)`, so the populated English value always wins even though corresponding zh-CN role keys exist.
- **Impact / failure scenario:** A Chinese user viewing built-in role assignments sees English role names and descriptions despite having complete Simplified-Chinese translations available.
- **Recommendation:** Persist stable role identifiers rather than locale-specific built-in copy. For system roles, resolve display names and descriptions from i18n keys first; reserve stored `displayName` for genuinely user-defined roles.

#### \[MEDIUM] Registry exposes production extension points with no consumers

- **Dimension:** 3 / Dead code & dev cruft
- **Location:** `src/enterprise/client/registry.ts:7`
- **Problem:** Menu-item and system-check registration APIs collect data that no production code reads, and no production module registers anything.
- **Evidence:** Repository-wide references to `getMenuItems()` and `getSystemChecks()` are limited to their definitions and registry tests; `.register(...)` calls likewise occur only in tests. `list()` has no callers.
- **Impact / failure scenario:** A module can successfully register a navigation item or health check, receive no error, and still have nothing appear or execute. This creates deceptive, unmaintained scaffolding and encourages modules to depend on a nonfunctional contract.
- **Recommendation:** Remove the unused APIs until there is a concrete consumer, or wire them into navigation and system-check execution with production registrations and integration tests. Make unsupported registration fail explicitly rather than silently accumulating unreachable data.

#### \[LOW] Admin navigation, routing, and icon metadata are parallel catalogs

- **Dimension:** 1 / Code smells
- **Location:** `src/enterprise/client/nav/adminNavMeta.ts:1`, `src/enterprise/client/routes/createAdminRouteTree.tsx:114`, `src/enterprise/client/features/admin/layout/AdminSideNav.tsx:47`
- **Problem:** Admin section IDs are independently mapped to navigation metadata, route elements, and icons through separate switches/catalogs.
- **Evidence:** `resolveAdminLeafElement` defaults to a placeholder for unknown IDs, while the sidebar maintains another ID-to-icon switch. Route tests generally assert that an element exists, not that a non-placeholder catalog item resolves to its intended page.
- **Impact / failure scenario:** Adding a non-placeholder navigation item but forgetting one parallel switch silently produces a placeholder page or fallback icon instead of a compile-time error.
- **Recommendation:** Define route loader/element and icon metadata in one typed descriptor catalog, derive navigation and routes from it, and add an exhaustive assertion that every non-placeholder item resolves to its intended component.

#### \[LOW] Client service layer retains verified unused compatibility state and stubs

- **Dimension:** 3 / Dead code & dev cruft
- **Location:** `src/enterprise/client/services/adminAgents.ts:5`, `src/enterprise/client/services/adminSkills.ts:34`, `src/enterprise/client/services/adminAiInfraAdapter/AdminAiModelService.ts:82`
- **Problem:** The service layer contains an unused exception class, a module-global publish-outcome channel without a production reader, and a lookup method that unconditionally returns `undefined`.
- **Evidence:** `PlatformAgentRolloutUnavailableError` has no repository-wide caller; skill outcome getters/clearers are referenced only by mocks/tests; `getAiModelById()` is an unconditional `return undefined` and has no production invocation.
- **Impact / failure scenario:** Callers and tests can infer capabilities that do not exist, while module-global state can leak between tests or future consumers. The inert lookup method makes “not implemented” indistinguishable from a genuinely missing model.
- **Recommendation:** Delete the obsolete exception and outcome channel unless a production consumer is added. Remove the hollow model lookup or implement it through the real adapter contract with explicit unsupported/error semantics.

### Metrics

- Total findings: 13 (CRITICAL 0, HIGH 7, MEDIUM 4, LOW 2)
- Largest in-scope files (lines): `src/enterprise/client/nav/adminNavMeta.ts` (499), `apps/server/src/enterprise/runtimeConfig/domainCache.cluster.redis.pg.test.ts` (394), `apps/server/src/enterprise/runtimeConfig/domainCache.test.ts` (393)
- Dead-code candidates verified unused repo-wide: 6
