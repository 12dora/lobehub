# Round 5 Audit — srv-platform-core

## Scope

Audited the fork-owned delta under:

- `apps/server/src/enterprise/services/platformInstance`
- `apps/server/src/enterprise/services/platformSystem`
- The assigned platform publishing, snapshot, capability, dependency-lock, invalidation, and managed-resource services and tests
- `apps/server/src/enterprise/runtimeConfig`
- `apps/server/src/enterprise/featureFlags`
- `apps/server/src/enterprise/bootstrap`
- `apps/server/src/enterprise/testing`
- `apps/server/src/enterprise/services/__tests__`
- `apps/server/src/enterprise/services/__test-support__`

The baseline comparison found **53 added files and 10,542 added LOC**. All 53 files were fork-owned additions; no upstream-identical files were included.

The assigned path `apps/server/src/enterprise/services/platformRbac` does not exist and matched no files. The sibling file `platformRbac.ts` was therefore excluded because it was not included by the supplied pathspec.

The Round-4 remediation commits were checked against this scope. Commit `4f68061410` modified scoped files and is relevant to findings below; the other listed remediation commits did not touch the scoped paths.

## Summary

| Dimension                                             | Findings | Highest severity |
| ----------------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                        |        2 | MEDIUM           |
| D2 Test decay                                         |        1 | MEDIUM           |
| D3 Dead code and development debris                   |        1 | MEDIUM           |
| D4 Missing Simplified Chinese i18n coverage           |        0 | —                |
| D5 Potential functional bugs                          |        6 | HIGH             |
| D6 Warnings and errors not surfaced via toast         |        0 | —                |
| D7 Overly technical/internal-state-leaking UI strings |        0 | —                |
| D8 Missing animations/motion                          |        0 | —                |

## Findings

### srv-platform-core-D5-1 — Disabled builtin-override tombstones disappear from the skill-catalog health target

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:195-213`, `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:335-403`
- **Confidence:** HIGH
- **What:** The lightweight target projection recognizes a tombstone only when the mutable skill pointer remains enabled:
  ```ts
  const tombstone = row.status === 'archived' && row.enabled && row.allowBuiltinOverride;
  ```
  A valid tombstone produced by archiving a disabled builtin override has `row.enabled === false`, so the projection skips it.
- **Evidence:** The immutable published revision is the runtime authority and deliberately represents a builtin-override tombstone as enabled. The database publication path forces `payload.skill.enabled = true` for such tombstones, while materializing the pointer only changes version, revision, and status; it does not restore the mutable pointer’s `enabled` field. The existing skill-catalog regression test archives a previously disabled builtin override and expects that tombstone to keep suppressing the builtin. The full snapshot loader at lines 195–213 reads the immutable revision payload correctly, but the lightweight health target at lines 389–393 derives tombstone state from the mutable pointer. Scoped tests only cover tombstone rows whose pointer is still enabled.
- **Impact:** After disabling and then archiving a builtin override, runtime behavior can be correct while the platform health target computes a different token. The instance can consequently be reported as perpetually diverged, making convergence monitoring unreliable for the exact case prior remediation was meant to protect.
- **Fix:** Derive tombstone membership and effective enabled state from immutable revision payload fields such as `builtinOverrideTombstone` and `skill.enabled`, using scalar JSON projection if a full payload load is too expensive. Add an integration regression that disables and archives a builtin override, then asserts that the lightweight target token equals the full runtime token.

### srv-platform-core-D5-2 — NULL OIDC revision reports can be counted as converged

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/platformInstance/statusService.ts:129-139`, `apps/server/src/enterprise/services/platformInstance/statusService.ts:384-459`
- **Confidence:** HIGH
- **What:** Identity convergence uses ordinary SQL equality and negation:
  ```ts
  matches = eq(activeIdentityRevision, target);
  ...
  not(matches)
  ```
  When the target is non-null but a fresh remote instance reports `activeIdentityRevision = NULL`, both `matches` and `NOT matches` evaluate to SQL `NULL`.
- **Evidence:** Such an instance increments `fresh`, but it increments neither `matching` nor `diverged`. `unreported` is hardcoded to zero. With no other failures, `convergenceStatus` sees `diverged === 0` and `unreported === 0` and returns `converged`. The issue-row query uses the same nullable negation, so the missing revision is also omitted from the issue set. The scoped PGlite tests cover matching non-null remote revisions and local LKG behavior, but not an OIDC-enabled remote instance with a non-null target and null report.
- **Impact:** The administration view can claim identity configuration is fully converged even though a live instance has never reported loading the target revision. This can conceal incomplete rollouts or stale instances.
- **Fix:** Use a null-safe comparison such as `active_identity_revision IS DISTINCT FROM target`, or explicitly classify `NULL` as unreported/diverged. Apply the same predicate to aggregate counts and issue-row selection. Add a PGlite regression for a fresh remote instance with a null active revision.

### srv-platform-core-D1-1 — Concurrent catalog target misses repeat the entire catalog scan

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:306-319`, `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:420-437`, `apps/server/src/enterprise/services/platformInstance/catalogTokens.ts:63-165`, `apps/server/src/enterprise/services/platformInstance/catalogTokens.test.ts:106-190`
- **Confidence:** HIGH
- **What:** The AI-model and skill target loaders check a completed cached slot and, on a miss, independently scan and hash the full catalog. The token cache stores only completed results; it does not retain or coalesce an in-flight computation.
- **Evidence:** Every concurrent caller can observe the same cold or invalidated slot, execute the database scan, build the token, and then overwrite the slot with an equivalent result. Performance tests use catalogs of 5,000 AI entries and 8,000 skill entries but exercise only sequential steady-state reads, so they do not cover a concurrent cold miss.
- **Impact:** Cold starts and catalog-generation changes can produce a thundering herd of duplicate full-catalog reads and hashing work. This increases database load and status latency precisely during publication and recovery events.
- **Fix:** Coalesce in-flight work by domain, generation, and local epoch, clearing the promise in `finally`. Recheck authority before publishing the result. Add a `Promise.all` regression proving that concurrent misses issue one scan.

### srv-platform-core-D2-1 — Round-4 checksum validation made the catalog publication test fail before its assertions

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/enterprise/services/platformInstance/catalogAuthority.publication.pg.test.ts:191-220`
- **Confidence:** HIGH
- **What:** The test constructs a resource with content `"reference"` but assigns the checksum `'a'.repeat(64)`.
- **Evidence:** Round-4 commit `4f68061410` added content-bound SHA-256 validation. The SHA-256 digest of `"reference"` is `52367a6622b19f08825e915fad80c542ad4f4c34dbcebad9f5007994b3e39208`, so the fixture fails schema validation before reaching the generation-bump and atomic-publication assertions. Sibling skill-catalog tests were updated to call `skillResourceContentChecksum`, but this scoped test was missed.
- **Impact:** The test no longer verifies the publication invariant it was written for and can leave CI failing for a fixture error rather than a product regression.
- **Fix:** Compute the fixture checksum with `skillResourceContentChecksum(resourceContent)` and compute `sizeBytes` from the encoded content. Preserve the existing atomic-generation assertions.

### srv-platform-core-D3-1 — Managed-skill runtime resolver and cache have no production caller

- **Severity:** MEDIUM
- **Dimension:** D3 Dead code and development debris
- **Location:** `apps/server/src/enterprise/services/managedResourceCapabilities.ts:21-46`, `apps/server/src/enterprise/services/managedResourceCapabilities.ts:103-143`, `apps/server/src/enterprise/services/managedResourceCapabilities.test.ts:39-141`
- **Confidence:** HIGH
- **What:** `resolveManagedSkillRuntimeMode` and its private epoch/TTL cache are exercised by tests but are not called or imported by production code.
- **Evidence:** A repository-wide symbol search found only the definition and its dedicated test references. Production paths instead use `resolvePublishedManagedResourcePolicies` and `getManagedSkillRuntimeModeSnapshot`.
- **Impact:** The repository maintains and tests a second cache/resolution path that never affects runtime behavior. This creates false confidence in tests and makes future policy-cache changes easy to implement in the wrong abstraction.
- **Fix:** Remove the unused resolver and cache, or deliberately wire it into a documented non-hot bootstrap path. Consolidate runtime-mode caching around the production snapshot/published-policy path.

### srv-platform-core-D5-3 — Managed-resource policy publication failures are absent from system health

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/platformSystem/adminService.ts:274-282`, `apps/server/src/enterprise/services/platformSystem/adminService.ts:549-575`, `apps/server/src/enterprise/services/managedResourcePolicy.ts:194-200`
- **Confidence:** HIGH
- **What:** `publicationDomains` maps publication audit actions for agents, providers, branding, connectors, identity, settings, and skills, but omits `admin.managedResources.publish`.
- **Evidence:** `ManagedResourcePolicyService` records failed publications using exactly `admin.managedResources.publish`. The health query filters audit rows to `Object.keys(publicationDomains)`, so the missing action is excluded before both counting and item projection.
- **Impact:** Failed managed-resource policy publications are invisible in “recent publish failures,” causing the dashboard to under-report failed administrative changes.
- **Fix:** Add:
  ```ts
  'admin.managedResources.publish': 'managed_policy'
  ```
  to the mapping and add a regression that inserts a failed managed-resource publication audit and verifies its count and projected domain.

### srv-platform-core-D5-4 — “Recent publish failures” count is an all-time total

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/platformSystem/adminService.ts:549-575`
- **Confidence:** HIGH
- **What:** The service selects the latest ten failures but calculates `count(*) OVER()` across every matching failure ever recorded. There is no `createdAt` predicate or other recency boundary.
- **Evidence:** The user-facing en-US and zh-CN labels describe the value as “recent publish failures” and “近期发布失败”. The query only filters by failure result and publication action. The existing test inserts one current failure and therefore cannot distinguish a recent count from a lifetime count.
- **Impact:** A historical publication failure can keep the dashboard’s “recent” failure count nonzero indefinitely, producing stale operational alerts and obscuring whether the current system is healthy.
- **Fix:** Define a documented recency window, inject the current time for deterministic testing, and apply the timestamp predicate before the window count. Alternatively, rename the API field and UI copy to state that the count is all-time. Add boundary tests for failures inside and outside the window.

### srv-platform-core-D5-5 — Default break-glass bootstrap is not idempotent as documented

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/bootstrap/superAdmin.ts:21`, `apps/server/src/enterprise/bootstrap/superAdmin.ts:102-149`
- **Confidence:** HIGH
- **What:** The bootstrap contract states that rerunning is safe, but creation without an explicit email or user ID generates a timestamp-based ID and email while always defaulting the username to `breakglass`.
- **Evidence:** The second identical invocation has no stable selector with which to find the first account. It produces a new ID and email, then attempts another insert with the unique username `breakglass`, causing a uniqueness failure. Scoped idempotence tests use an existing `userId`; they do not rerun the default no-email creation path.
- **Impact:** An emergency bootstrap procedure that is retried after uncertain completion can fail instead of safely returning the existing super administrator, making recovery operations brittle.
- **Fix:** Require a stable email or username for creation, or persist and resolve a deterministic bootstrap identity before insertion. Add a regression that runs the same default bootstrap twice and asserts the same user is returned without a second insert.

### srv-platform-core-D5-6 — Break-glass email lookup does not use normalized identity matching

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/bootstrap/superAdmin.ts:93-99`, `apps/server/src/enterprise/bootstrap/superAdmin.ts:126-136`
- **Confidence:** HIGH
- **What:** Existing-user resolution performs case-sensitive equality against `users.email`, and creation stores the supplied casing directly as `normalizedEmail`.
- **Evidence:** The repository’s shared administrative user lookup trims and lowercases email and checks both email and normalized-email forms. This bootstrap path bypasses that model. PostgreSQL’s ordinary unique email constraint is case-sensitive, while the lowercase lookup indexes are not unique, so a casing variant can be treated as a different account.
- **Impact:** An operator can fail to resolve the intended existing user. With creation enabled, the command may create and grant `super_admin` to a second case-variant account; without creation, it can incorrectly report that the user is missing.
- **Fix:** Reuse the shared normalized administrative-user lookup and store `normalizedEmail` in lowercase. Add tests using a differently cased form of an existing address, with creation both enabled and disabled.

### srv-platform-core-D1-2 — Two managed-resource failure paths dump raw error objects

- **Severity:** LOW
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/services/managedResourcePolicy.ts:204-222`, `apps/server/src/enterprise/services/managedResourceReadiness.ts:22-36`
- **Confidence:** HIGH
- **What:** These paths call `console.error` with the complete caught error, unlike nearby platform services that emit stable error classes or structured observability records.
- **Evidence:** A repository search of the scoped services found these two raw-error calls; the other scoped failure paths either rethrow, record structured audit data, or log a classified value.
- **Impact:** Stack traces, driver details, SQL metadata, or sensitive contextual fields can be written to unstructured process logs. The events are also harder to correlate and aggregate reliably.
- **Fix:** Emit a stable error classification through the repository’s debug namespace or structured observer and retain the original exception only in a controlled diagnostic field with appropriate redaction.

## Dimensions with no findings

- **D4 Missing Simplified Chinese i18n coverage:** The scoped code is server-side service, bootstrap, configuration, and test code. Hardcoded strings were checked for user-facing use; no fork-owned UI copy or locale keys requiring zh-CN translation were found.
- **D6 Warnings and errors not surfaced via toast:** The scope contains no client mutation handlers or UI components capable of presenting `Toast`/`message`. User-triggered backend failures are propagated or returned for the router/client layer rather than being silently converted into success.
- **D7 Overly technical/internal-state-leaking UI strings:** Public system projections and stable error classifications were inspected. No scoped code directly renders raw stacks, SQL, UUIDs, internal enum values, or operational jargon to end users.
- **D8 Missing animations/motion:** No user-interface components, panels, lists, modals, loading views, or visual state transitions exist in the assigned server-side scope, so upstream UI-library motion is not applicable.

## Cross-scope notes

- The assignment listed `apps/server/src/enterprise/services/platformRbac` without the `.ts` extension. That path does not exist, while `apps/server/src/enterprise/services/platformRbac.ts` does; it should be explicitly assigned if the RBAC service was intended to be part of this audit.
- The tombstone convergence finding interacts with `packages/database/src/models/platform/skillCatalog.pointer.ts`, whose immutable publication payload intentionally forces the tombstone’s effective enabled state while retaining the disabled mutable pointer. Any correction should preserve that database-side invariant.
