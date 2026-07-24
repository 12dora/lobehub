## Partition: contracts

Scope reviewed: All `.ts`/`.tsx` files under `apps/server/src/enterprise/contracts`.
Files examined: 56 TypeScript files: 43 source/barrel files and 13 tests.

### Summary

The contracts are generally strict and current database-backed enums agree, but several schemas fail to encode invariants enforced deeper in the service or model layers. The highest risk is inconsistent secret detection on audit reasons and revision comments, allowing credentials to be persisted in ostensibly administrative metadata. Other correctness issues include invalid legal-hold shapes, permissive date coercion, rollout state drift, and rejection of valid semantic versions. Tests are substantial but occasionally preserve incorrect behavior, while two exported contract artifacts are unused or stale repo-wide.

### Findings

#### \[HIGH] Audit reasons and revision comments can persist secrets

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/contracts/adminUsers.ts:50`; `apps/server/src/enterprise/contracts/adminBranding.ts:104`; `apps/server/src/enterprise/contracts/adminBranding.ts:165`; `apps/server/src/enterprise/contracts/adminManagedResources.ts:43`; `apps/server/src/enterprise/contracts/adminManagedResources.ts:59`; `apps/server/src/enterprise/contracts/adminSettings.ts:95`
- **Problem:** These audit metadata fields use only length and whitespace validation, unlike the secret-aware validators already used by `adminAudit`, `adminSystem`, identity-provider, platform-agent, and settings reason schemas.
- **Evidence:** The affected schemas accept values such as `Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345`. For example, `adminUsers.ts` defines `reasonSchema = z.string().trim().min(1).max(2000)`, and `adminSettings.ts` validates `comment` with only `z.string().max(2000).optional()`. Repo-wide verification shows these values are forwarded to audit records or revision comments without redaction; the separate AI-catalog service does sanitize equivalent text.
- **Impact / failure scenario:** An administrator pastes a bearer token, API key, or credential into a ban reason, branding publication reason, managed-resource comment, or settings publication comment. The request passes validation and the secret is stored in audit/history data, where it can later be exposed to auditors, revision viewers, or exports.
- **Recommendation:** Define one shared secret-safe schema for audit reasons and comments and apply it to every persisted metadata field. Add regression tests covering bearer tokens, API keys, authorization headers, and secret-bearing publication comments.

#### \[MEDIUM] Role replacement accepts preserved roles absent from the replacement set

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/contracts/adminUsers.ts:342`
- **Problem:** The schema documents that `preserveRoleNames` must be a subset of `roleNames`, but never validates that invariant.
- **Evidence:** `adminUsersReplaceGlobalRolesInputSchema.safeParse({ userId: 'u', reason: 'x', roleNames: [], preserveRoleNames: ['platform_user'] })` succeeds. The existing refinement at lines 358–364 checks only whether `expiresAt` is in the past. Repo-wide verification shows the database operation excludes preserved roles from deletion.
- **Impact / failure scenario:** A caller requests `roleNames: []`, nominally replacing all global roles with none, but supplies an existing privileged role in `preserveRoleNames`. That role survives the replacement even though it was not included in the desired role set, potentially defeating an intended access revocation.
- **Recommendation:** Add a refinement requiring every preserved role to occur in `roleNames`, reject duplicates, and add regression tests for empty, partial, and invalid subset combinations.

#### \[MEDIUM] Legal-hold scope type and scope ID are not validated together

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/contracts/adminAudit/legalHolds.ts:16`; `apps/server/src/enterprise/contracts/adminAudit/legalHolds.ts:63`
- **Problem:** Both list and create schemas model `scopeType` and `scopeId` independently. They accept a global hold with a non-null ID and a tenant/user/department/organization hold without an ID.
- **Evidence:** The create schema accepts both `{ scopeType: 'global', scopeId: 'unexpected', ... }` and `{ scopeType: 'user', scopeId: null, ... }`. The database model requires global scopes to have no ID and non-global scopes to have a nonempty ID.
- **Impact / failure scenario:** An invalid create request passes tRPC validation and fails later in the model with an internal error. An invalid list filter such as `scopeType: 'user', scopeId: null` instead generates a contradictory query and silently returns no holds.
- **Recommendation:** Replace the independent fields with a discriminated union: global requires an omitted/null ID, while every non-global type requires a nonempty ID. Reuse it across list and create schemas and add a complete valid/invalid scope matrix test.

#### \[MEDIUM] Date coercion converts booleans and null into epoch timestamps

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/contracts/adminAudit/common.ts:40`; `apps/server/src/enterprise/contracts/adminUsers.ts:74`; `apps/server/src/enterprise/contracts/adminUsers.ts:203`; `apps/server/src/enterprise/contracts/adminUsers.ts:342`
- **Problem:** `z.coerce.date()` accepts values far beyond the documented SuperJSON `Date` input, including `null`, `false`, `true`, and numeric values.
- **Evidence:** Runtime parsing produces `1970-01-01T00:00:00.000Z` for `null`, `false`, and `0`, and one millisecond later for `true`. The contract comment explicitly states that tRPC receives real `Date` instances via SuperJSON.
- **Impact / failure scenario:** A malformed client sends `{ createdTo: true }`; it becomes a 1970 cutoff and returns an unexpectedly empty user list instead of a validation error. Similarly, `null` audit bounds become epoch filters, and `expiresAt: null` is misinterpreted as a past date rather than rejected as the wrong shape.
- **Recommendation:** Use `z.date()` for SuperJSON procedures. If string compatibility is required, preprocess only `Date` instances and validated ISO strings while explicitly rejecting booleans, null, and numbers. Add negative coercion tests.

#### \[MEDIUM] Rollout contracts and tests disagree with the service state machine

- **Dimension:** 2 / Test rot
- **Location:** `apps/server/src/enterprise/contracts/platformAgents/rollout.ts:58`; `apps/server/src/enterprise/contracts/platformAgents/rollout.ts:68`; `apps/server/src/enterprise/contracts/platformAgents/rollout.ts:73`; `apps/server/src/enterprise/contracts/platformAgents.test.ts:432`
- **Problem:** Cancel, retry, and rollback reuse or repeat a schema that permits all six rollout statuses, although each operation is valid from a different restricted state set. The test explicitly treats rollback from `dead` as valid even though the service only rolls back completed/succeeded rollouts.
- **Evidence:** `adminPlatformAgentRolloutCancelInputSchema` and `adminPlatformAgentRolloutRetryInputSchema` alias the same common schema. The rollback schema also uses the unrestricted status enum. At lines 474–482, the test asserts that `expectedStatus: 'dead'` parses successfully for rollback; service verification shows cancel allows pending/running, retry allows cancelled/dead/failed, and rollback requires completed.
- **Impact / failure scenario:** An external or older client is told by generated types that an invalid transition is legal. Its request passes the public contract but fails in the service, producing avoidable conflicts and making the contract test suite certify behavior the application cannot perform.
- **Recommendation:** Define operation-specific expected-status schemas: cancel `pending|running`, retry `cancelled|dead|failed`, and rollback `completed`. Fix the stale rollback test and add an explicit acceptance/rejection matrix for all transitions.

#### \[MEDIUM] Valid SemVer versions containing build metadata are rejected

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/contracts/skillCatalog.ts:22`; `apps/server/src/enterprise/contracts/platformAgents/common.ts:30`; `apps/server/src/enterprise/contracts/skillCatalog.test.ts:110`
- **Problem:** Both version schemas require `semver.valid(value) === value`. The `semver` package returns a normalized version without build metadata, so valid SemVer such as `1.2.3+build.5` fails that equality test.
- **Evidence:** `semver.valid('1.2.3+build.5')` returns `1.2.3`; the schema therefore rejects it. The skill test’s invalid-version list explicitly includes `1.2.3+build.5`, preserving the defect.
- **Impact / failure scenario:** A valid imported skill or platform-agent release such as `2.4.0+corp.17` cannot be registered or appended, despite the database using unrestricted string columns and SemVer 2.0 allowing build metadata.
- **Recommendation:** Validate strict SemVer without comparing against the package’s build-stripped normalized return. Preserve rejection of `v` prefixes and leading-zero versions, and add positive tests for build metadata in both skill and agent contracts.

#### \[MEDIUM] “Bounded” JSON validation has unbounded recursive depth

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/contracts/aiCatalog.ts:18`
- **Problem:** `validateNonSecretJson` recursively traverses every array and object without a depth, node-count, or serialized-size limit. The exported `boundedJsonObjectSchema` is therefore not actually bounded.
- **Evidence:** A 12,000-level nested object parses successfully, while deeper objects trigger an uncaught `RangeError` from recursive traversal rather than returning a Zod validation failure. Numerous provider and model configuration fields use this validator.
- **Impact / failure scenario:** An authenticated administrator submits a moderately sized but deeply nested provider configuration. Contract parsing exhausts the JavaScript stack and produces a 500 response, potentially disrupting the request worker.
- **Recommendation:** Replace recursion with iterative traversal and enforce explicit maximum depth, node count, key count, and serialized size. Add boundary tests and verify that over-limit inputs return ordinary Zod errors without throwing.

#### \[LOW] Two exported contract artifacts are unused or stale repo-wide

- **Dimension:** 3 / Dead code & dev cruft
- **Location:** `apps/server/src/enterprise/contracts/platformAgents/assignments.ts:12`; `apps/server/src/enterprise/contracts/platformAgents/types.ts:77`; `apps/server/src/enterprise/contracts/platformConnectors/permissions.ts:1`
- **Problem:** The platform-agent assignment create schema/type has no router or client consumer because the live API uses assignment upsert. The connector procedure-permission map is not used by authorization and omits multiple live procedures.
- **Evidence:** Repo-wide searches find `adminPlatformAgentAssignmentCreateInputSchema` only in its definition, barrel export, and inferred type. `ADMIN_CONNECTOR_PROCEDURE_PERMISSIONS` appears only in its definition, barrel, and test. Its test uses `toMatchObject` for six entries, so it passes despite omitting live batch, immediate-publication, and governance procedures; actual authorization uses the separate dual registries.
- **Impact / failure scenario:** Maintainers may update or rely on these apparent sources of truth even though they do not affect runtime behavior. The stale permission map can falsely suggest that connector procedure coverage is complete.
- **Recommendation:** Delete the unused assignment-create schema/type and the stale permission catalog/test. If a readable permission catalog is required, generate it from the actual security and policy registries rather than maintaining a third list.

#### \[LOW] Assignment shape and cross-field invariants are duplicated four times

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/contracts/platformAgents/assignments.ts:12`; `apps/server/src/enterprise/contracts/platformAgents/assignments.ts:51`; `apps/server/src/enterprise/contracts/platformAgents/assignments.ts:94`; `apps/server/src/enterprise/contracts/platformAgents/domain.ts:56`
- **Problem:** The same assignment fields and two refinements—global target pairing and pinned-version pairing—are repeated across create, upsert, preview, and output schemas.
- **Evidence:** Each schema independently repeats the condition `(targetType === 'global') === (targetId === PLATFORM_AGENT_GLOBAL_TARGET_ID)` and the pinned policy condition. The existing parity test compares only upsert and preview, excluding create and domain output.
- **Impact / failure scenario:** A new assignment mode, target constraint, or error condition can be added to one schema but omitted from another, causing client previews, mutations, and server outputs to disagree.
- **Recommendation:** Extract a shared assignment core schema and shared refinement, then extend it with identity, concurrency, reason, and output fields. Test all derived schemas from one invariant matrix.

#### \[LOW] Managed-resource contracts duplicate the shared enum and resource catalog

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/contracts/adminManagedResources.ts:3`; `apps/server/src/enterprise/contracts/adminManagedResources.ts:12`; `apps/server/src/enterprise/contracts/adminManagedResources.ts:22`
- **Problem:** The contract hardcodes the enforcement modes once and the five resource kinds twice instead of deriving them from the repository’s shared managed-resource constants.
- **Evidence:** The literals `observe`, `ui-only`, and `enforced` duplicate `MANAGED_RESOURCE_ENFORCEMENT_MODES`; both object schemas repeat the same five keys already defined by `MANAGED_RESOURCE_KINDS`. They currently agree, but there is no mechanical linkage.
- **Impact / failure scenario:** Adding a resource kind or enforcement mode to the shared platform model can leave tRPC rejecting the new database/client-supported value or omitting it from policy/readiness responses.
- **Recommendation:** Import the shared enforcement tuple for `z.enum` and derive both exact maps from a single shared resource-kind definition. Add a parity test if Zod requires an explicit object shape.

#### \[LOW] Connector contract test file exceeds the repository size guideline

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/contracts/platformConnectors.test.ts:1`
- **Problem:** The 941-line test file exceeds the repository’s approximately 800-line file guideline and combines unrelated contract domains.
- **Evidence:** Its test cases cover secret handling, URL validation, normalizers, OAuth, projection schemas, runtime settings, and the stale permission catalog in one file.
- **Impact / failure scenario:** Broad imports and distant fixtures make focused changes harder to review and increase the chance that obsolete assertions remain unnoticed, as occurred with the permission catalog.
- **Recommendation:** Split it into focused tests aligned with the source modules, such as secrets, URLs/OAuth, projections/runtime, mutation inputs, and governance.

Dimension 4: no significant findings.

### Metrics

- Total findings: 11 (CRITICAL 0, HIGH 1, MEDIUM 6, LOW 4)
- Largest in-scope files (lines): `platformConnectors.test.ts` 941; `aiCatalog.ts` 654; `skillCatalog.ts` 581
- Dead-code candidates verified unused repo-wide: 2
